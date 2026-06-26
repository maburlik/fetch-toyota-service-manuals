import commandLineArgs from "command-line-args";
import { chromium, Page } from "playwright";
import {
  playwrightCookiesFromString,
  resolveCookieString,
} from "./lib/harCookie";
import { TIS_ORIGIN } from "../src/api/client";

/**
 * Look up the publication codes (Repair Manual, EWD, Body Manual, …) for a
 * given vehicle by driving the TIS catalog: it selects the division/model/year
 * on the repair-search form, then visits each document-type tab and scrapes the
 * `publicationNumber`/`objType` off the result links.
 *
 * Usage:
 *   TIS_COOKIE='...' ts-node tools/lookupCodes.ts --model RAV4 --year 2020
 *   ts-node tools/lookupCodes.ts --model "RAV4 HV" --year 2020 --har ~/Downloads/techinfo.har
 *
 * Output lists each code with the exact `-m` flag to pass to the downloader.
 */

const TIS_CATALOG_URL = `${TIS_ORIGIN}/t3Portal/appmanager/t3/ti?_nfpb=true&_pageLabel=t3_tis`;

// WebLogic portlet-mangled field names on the repair-search form.
const FIELD = {
  division: "repairformwlw-select_key:{actionForm.division}",
  model: "repairformwlw-select_key:{actionForm.model}",
  year: "repairformwlw-select_key:{actionForm.year}",
};

// How long to let the cascading dropdowns / search settle after an interaction.
const SETTLE_MS = 2500;
const SEARCH_SETTLE_MS = 4000;

interface FoundDoc {
  type: string; // objType, e.g. "rm", "ewdappu", "bm"
  publicationNumber: string;
}

/** Pull distinct {objType, publicationNumber} pairs out of result-link hrefs. */
function parseDocsFromHrefs(hrefs: (string | null)[]): FoundDoc[] {
  const seen = new Map<string, FoundDoc>();
  for (const href of hrefs) {
    if (!href) continue;
    const pub = (href.match(/publicationNumber=([^&]+)/) || [])[1];
    if (!pub) continue;
    const type =
      (href.match(/objType=([^&]+)/) || [])[1] ||
      (href.match(/[?&]dir=([a-z]+)/) || [])[1] ||
      "?";
    const publicationNumber = decodeURIComponent(pub);
    seen.set(`${type}:${publicationNumber}`, { type, publicationNumber });
  }
  return [...seen.values()];
}

/** Collect document links across every frame of the current page. */
async function docsOnPage(page: Page): Promise<FoundDoc[]> {
  let hrefs: (string | null)[] = [];
  for (const frame of page.frames()) {
    const frameHrefs = await frame
      .$$eval("a[href]", (as) => as.map((a) => a.getAttribute("href")))
      .catch(() => [] as (string | null)[]);
    hrefs = hrefs.concat(frameHrefs);
  }
  return parseDocsFromHrefs(hrefs);
}

/** Select a cascading dropdown value and wait for any dependent reload. */
async function selectAndSettle(page: Page, name: string, value: string) {
  const selector = `select[name="${name}"]`;
  await page.waitForSelector(selector, { timeout: 30000 });
  await Promise.all([
    page.waitForLoadState("domcontentloaded").catch(() => {}),
    page.selectOption(selector, value).catch((e) => {
      throw new Error(`Could not select ${name}="${value}": ${e.message}`);
    }),
  ]);
  await page.waitForTimeout(SETTLE_MS);
}

/** Human label for an objType. */
function typeLabel(type: string): string {
  switch (type) {
    case "rm":
      return "Repair Manual";
    case "ewdappu":
      return "Wiring Diagram (modern EWD)";
    case "ewd":
      return "Wiring Diagram (legacy)";
    case "bm":
      return "Body/Collision Manual";
    case "ncf":
      return "New Car Features";
    default:
      return type;
  }
}

/** The exact downloader `-m` flag for a given objType + publication number. */
function downloaderFlag(type: string, pub: string, year: string): string {
  const upper2 = pub.slice(0, 2).toUpperCase();
  switch (type) {
    case "rm":
      // Repair manuals support year filtering; legacy ids need an explicit type.
      return upper2 === "RM" ? `-m ${pub}@${year}` : `-m rm:${pub}@${year}`;
    case "ewdappu":
      return upper2 === "EM" ? `-m ${pub}` : `-m em:${pub}`;
    case "ewd":
      return `-m ewd:${pub}`;
    case "bm":
      return upper2 === "BM" ? `-m ${pub}@${year}` : `-m bm:${pub}@${year}`;
    default:
      return `-m ${pub}`;
  }
}

async function main() {
  const opts = commandLineArgs([
    { name: "model", type: String },
    { name: "year", type: String },
    { name: "division", type: String, defaultValue: "TOYOTA" },
    { name: "har", type: String },
  ]);

  if (!opts.model || !opts.year) {
    console.error(
      "Usage: ts-node tools/lookupCodes.ts --model <Model> --year <Year> [--division TOYOTA] [--har <har-path>]"
    );
    process.exit(2);
  }

  const cookieString = resolveCookieString(opts.har);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    storageState: {
      cookies: playwrightCookiesFromString(cookieString),
      origins: [],
    },
  });
  page.setDefaultTimeout(30000);

  try {
    await page.goto(TIS_CATALOG_URL, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);

    // Fail fast with a clear message if the session is dead (expired, or bumped
    // by a concurrent login) -- otherwise the form selects never appear and we
    // would time out cryptically.
    if (/concurrentLoginFailure|custom-login|\/login/i.test(page.url())) {
      throw new Error(
        "TIS session is not valid (expired, or bumped by a concurrent login). " +
          "Capture a fresh HAR while logged in, with no other TIS sessions open."
      );
    }

    await selectAndSettle(page, FIELD.division, opts.division);
    await selectAndSettle(page, FIELD.model, opts.model);
    await selectAndSettle(page, FIELD.year, opts.year);

    // Run the repair search (lands on the Repair Manual results tab).
    await Promise.all([
      page.waitForLoadState("domcontentloaded").catch(() => {}),
      page
        .click('input[value="Search"], #searchButton')
        .catch((e) => console.error("Search click warning:", e.message)),
    ]);
    await page.waitForTimeout(SEARCH_SETTLE_MS);

    const byType = new Map<string, Set<string>>();
    const collect = (docs: FoundDoc[]) =>
      docs.forEach((d) => {
        if (!byType.has(d.type)) byType.set(d.type, new Set());
        byType.get(d.type)!.add(d.publicationNumber);
      });

    collect(await docsOnPage(page));

    // Visit every other document-type tab (lib_<type>_page) and scrape it too.
    const currentUrl = page.url();
    const tabHrefs: string[] = await page
      .$$eval("a[href]", (as) =>
        as
          .map((a) => (a as HTMLAnchorElement).href)
          .filter((h) => /_pageLabel=lib_[a-z]+_page/.test(h))
      )
      .catch(() => []);
    const uniqueTabs = [...new Set(tabHrefs)].filter((h) => h !== currentUrl);
    for (const href of uniqueTabs) {
      await page.goto(href, { waitUntil: "domcontentloaded" }).catch(() => {});
      await page.waitForTimeout(SETTLE_MS);
      collect(await docsOnPage(page));
    }

    console.log(`\nCodes for ${opts.division} ${opts.model} ${opts.year}:`);
    if (!byType.size) {
      console.log("  (no documents found -- check the model/year spelling)");
    } else {
      const flags: string[] = [];
      for (const [type, set] of [...byType.entries()].sort()) {
        for (const pub of [...set].sort()) {
          const flag = downloaderFlag(type, pub, opts.year);
          flags.push(flag.replace(/^-m /, ""));
          console.log(
            `  ${typeLabel(type).padEnd(28)} ${pub.padEnd(12)} ${flag}`
          );
        }
      }
      console.log(
        `\nDownload all:\n  yarn start ${flags.map((f) => `-m ${f}`).join(" ")}`
      );
    }
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(1);
});
