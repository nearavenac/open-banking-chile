import puppeteer, { type Page } from "puppeteer-core";
import type { BankScraper, ScrapeResult, ScraperOptions } from "../types";
import { closePopups, delay, findChrome, saveScreenshot } from "../utils";

const LOGIN_URL = "https://login.portales.bancochile.cl/login";
const API_CUENTAS_SALDOS =
  "https://portalpersonas.bancochile.cl/mibancochile/rest/persona/bff-pp-prod-ctas-saldos/productos/cuentas/saldos";

interface CuentaSaldo {
  codProducto: string;
  tipo: string;
  numero: string;
  disponible: number;
  cupo: number;
  moneda: string;
  descripcion: string;
}

const BALANCE_DOM_SELECTORS = [
  '[aria-label*="Saldo de cuenta es de"]',
  ".saldo-cuenta__balance",
  '[aria-label*="Saldo de cuenta"]',
  '[aria-label*="Saldo"]',
  '[class*="saldo-cuenta"]',
  '[class*="balance"]',
];

const RUT_SELECTORS = [
  "#ppriv_per-login-click-input-rut",
  'input[placeholder*="RUT"]',
  'input[placeholder*="rut"]',
  'input[name*="rut"]',
  'input[id*="rut"]',
];

const PASSWORD_SELECTORS = [
  "#ppriv_per-login-click-input-password",
  'input[type="password"]',
  'input[placeholder*="Contraseña"]',
  'input[placeholder*="contraseña"]',
  'input[name*="password"]',
  'input[name*="pass"]',
];

const SUBMIT_SELECTORS = [
  ".bch-login__submit__text",
  'button[type="submit"]',
  '[aria-label*="Ingresar"]',
];

async function login(
  page: Page,
  rut: string,
  password: string,
  debugLog: string[],
  doSave: (page: Page, name: string) => Promise<void>
): Promise<{ success: boolean; error?: string; screenshot?: string }> {
  debugLog.push("1. Navigating to login...");
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 20000 });
  await delay(3000);

  await doSave(page, "01-login-form");

  debugLog.push("2. Filling RUT...");
  let rutSelector: string | null = null;
  for (const sel of RUT_SELECTORS) {
    try {
      await page.waitForSelector(sel, { visible: true, timeout: 2000 });
      rutSelector = sel;
      break;
    } catch {
      continue;
    }
  }
  if (!rutSelector) {
    const screenshot = await page.screenshot({ encoding: "base64" });
    return { success: false, error: "RUT field not found", screenshot: screenshot as string };
  }

  const cleanRut = rut.replace(/[.\-\s]/g, "");
  await page.click(rutSelector);
  await page.type(rutSelector, cleanRut, { delay: 50 });
  await delay(300);

  debugLog.push("3. Filling password...");
  let passSelector: string | null = null;
  for (const sel of PASSWORD_SELECTORS) {
    try {
      await page.waitForSelector(sel, { visible: true, timeout: 2000 });
      passSelector = sel;
      break;
    } catch {
      continue;
    }
  }
  if (!passSelector) {
    const screenshot = await page.screenshot({ encoding: "base64" });
    return { success: false, error: "Password field not found", screenshot: screenshot as string };
  }

  await page.click(passSelector);
  await page.type(passSelector, password, { delay: 50 });
  await delay(500);

  debugLog.push("4. Submitting login...");
  await doSave(page, "02-pre-submit");

  let submitClicked = false;
  for (const sel of SUBMIT_SELECTORS) {
    try {
      const el = await page.$(sel);
      if (el) {
        await el.click();
        submitClicked = true;
        break;
      }
    } catch {
      continue;
    }
  }
  if (!submitClicked) {
    submitClicked = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll("button, a, [role=button]"));
      for (const btn of buttons) {
        const text = (btn as HTMLElement).innerText?.trim() || "";
        if (text.includes("Ingresar") || text.includes("INGRESAR")) {
          (btn as HTMLElement).click();
          return true;
        }
      }
      return false;
    });
  }

  try {
    await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => delay(5000));
  } catch {
    const loginStart = Date.now();
    while (Date.now() - loginStart < 15000) {
      const url = page.url();
      if (!url.includes("login.portales.bancochile.cl") && !url.includes("/login")) break;
      await delay(200);
    }
  }

  await delay(1000);

  const errorMessage = await page.evaluate(() => {
    const errorSelectors = ['[class*="error"]', '[class*="alert"]', '[class*="mensaje"]', ".text-danger", '[role="alert"]'];
    for (const selector of errorSelectors) {
      const elements = document.querySelectorAll(selector);
      for (const el of elements) {
        const text = (el as HTMLElement).textContent?.trim() || "";
        if (
          text &&
          (text.includes("incorrecto") ||
            text.includes("incorrectos") ||
            text.includes("bloqueada") ||
            text.includes("error") ||
            text.includes("Error"))
        ) {
          return text;
        }
      }
    }
    return null;
  });

  if (errorMessage) {
    await doSave(page, "03-login-error");
    const screenshot = await page.screenshot({ encoding: "base64" });
    return { success: false, error: `Login error: ${errorMessage}`, screenshot: screenshot as string };
  }

  if (page.url().includes("login.portales.bancochile.cl") || page.url().includes("/login")) {
    const screenshot = await page.screenshot({ encoding: "base64" });
    return { success: false, error: "No navigation after login.", screenshot: screenshot as string };
  }

  debugLog.push("5. Login OK");

  await closePopups(page);
  await doSave(page, "03-after-login");
  await delay(3000);

  return { success: true };
}

async function extractBalance(page: Page, debugLog: string[]): Promise<{ balance: number; currency: string } | null> {
  await delay(2000);

  const apiResult = await page.evaluate(async (apiUrl: string) => {
    try {
      const response = await fetch(apiUrl, {
        method: "GET",
        credentials: "include",
        headers: { Accept: "application/json, text/plain, */*" },
      });
      if (!response.ok) return null;
      const data = (await response.json()) as CuentaSaldo[];
      if (!Array.isArray(data) || data.length === 0) return null;
      const currentAccount = data.find((c) => c.tipo === "CUENTA_CORRIENTE");
      const vistaAccount = data.find((c) => c.tipo === "CUENTA_VISTA");
      const account = currentAccount ?? vistaAccount ?? data[0];
      if (account && typeof account.disponible === "number") {
        return { balance: account.disponible, currency: account.moneda || "CLP" };
      }
      return null;
    } catch {
      return null;
    }
  }, API_CUENTAS_SALDOS);

  if (apiResult) {
    debugLog.push("  Balance from API");
    return apiResult;
  }

  await delay(2000);

  const fromDomSelectors = await page.evaluate((selectors: string[]) => {
    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (el && (el as HTMLElement).offsetParent !== null) {
        const text = ((el as HTMLElement).textContent || (el as HTMLElement).innerText || "").trim();
        const ariaLabel = el.getAttribute("aria-label") || "";
        const fullText = text || ariaLabel;
        const match = fullText.match(/[\d.,]+/);
        if (match) {
          const numericStr = match[0].replace(/\./g, "").replace(",", ".");
          const balance = parseFloat(numericStr);
          if (!isNaN(balance)) return { balance, currency: "CLP" };
        }
      }
    }
    return null;
  }, BALANCE_DOM_SELECTORS);

  if (fromDomSelectors) return fromDomSelectors;

  const fromDom = await page.evaluate(() => {
    const bodyText = (document.body?.innerText || "").toLowerCase();
    const patterns = [
      /saldo\s*(?:disponible|cuenta)?\s*:?\s*\$?\s*([\d.,]+)/i,
      /\$?\s*([\d.,]+)\s*(?:clp|pesos)/i,
      /(?:tu\s+)?saldo\s+es\s+(?:de\s+)?\$?\s*([\d.,]+)/i,
    ];
    for (const re of patterns) {
      const m = bodyText.match(re);
      if (m) {
        const numericStr = m[1].replace(/\./g, "").replace(",", ".");
        const balance = parseFloat(numericStr);
        if (!isNaN(balance) && balance > 0) return { balance, currency: "CLP" };
      }
    }
    return null;
  });

  return fromDom;
}

async function scrape(options: ScraperOptions): Promise<ScrapeResult> {
  const { rut, password, chromePath, saveScreenshots: doScreenshots, headful } = options;
  const bank = "bancochile";

  if (!rut || !password) {
    return { success: false, bank, movements: [], error: "RUT and password required." };
  }

  const executablePath = findChrome(chromePath);
  if (!executablePath) {
    return {
      success: false,
      bank,
      movements: [],
      error:
        "Chrome/Chromium not found. Install it or set chromePath.\n  Ubuntu/Debian: sudo apt install chromium-browser\n  macOS: brew install --cask google-chrome",
    };
  }

  let browser;
  const debugLog: string[] = [];
  const doSave = async (page: Page, name: string) => saveScreenshot(page, name, !!doScreenshots, debugLog);

  try {
    browser = await puppeteer.launch({
      executablePath,
      headless: !headful,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--window-size=2560,911",
        "--disable-blink-features=AutomationControlled",
      ],
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 2560, height: 911 });
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36");
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
    });

    await page.setRequestInterception(true);
    page.on("request", (request) => {
      const resourceType = request.resourceType();
      if (["image", "font", "media"].includes(resourceType)) {
        request.abort();
      } else {
        request.continue();
      }
    });

    const loginResult = await login(page, rut, password, debugLog, doSave);
    if (!loginResult.success) {
      return {
        success: false,
        bank,
        movements: [],
        error: loginResult.error,
        screenshot: loginResult.screenshot,
        debug: debugLog.join("\n"),
      };
    }

    debugLog.push("6. Extracting balance...");
    const balanceResult = await extractBalance(page, debugLog);

    if (!balanceResult) {
      const screenshot = await page.screenshot({ encoding: "base64" });
      return {
        success: false,
        bank,
        movements: [],
        error: "Could not retrieve account balance",
        screenshot: screenshot as string,
        debug: debugLog.join("\n"),
      };
    }

    debugLog.push(`  Balance: $${balanceResult.balance.toLocaleString("es-CL")} ${balanceResult.currency}`);
    await doSave(page, "04-balance");

    const screenshot = await page.screenshot({ encoding: "base64", fullPage: true });

    return {
      success: true,
      bank,
      movements: [],
      balance: balanceResult.balance,
      screenshot: screenshot as string,
      debug: debugLog.join("\n"),
    };
  } catch (error) {
    return {
      success: false,
      bank,
      movements: [],
      error: `Scraper error: ${error instanceof Error ? error.message : String(error)}`,
      debug: debugLog.join("\n"),
    };
  } finally {
    await browser?.close().catch(() => {});
  }
}

const bancoChile: BankScraper = {
  id: "bancochile",
  name: "Banco de Chile",
  url: LOGIN_URL,
  scrape,
};

export default bancoChile;
