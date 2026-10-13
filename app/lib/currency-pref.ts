// The merchant's chosen display currency is remembered in the browser only (no database).
// Pages read it from `?cur=`, and <CurrencySync/> in the app layout re-adds it to the URL on navigation.

export const CUR_KEY = "eco_cur";

export const savedCurrency = (): string | null => {
  try {
    return localStorage.getItem(CUR_KEY);
  } catch {
    return null; // storage blocked (private mode / third-party iframe rules): the pickers still work per page
  }
};

export const saveCurrency = (code: string) => {
  try {
    localStorage.setItem(CUR_KEY, code);
  } catch {
    /* ignore */
  }
};

/** Pages whose loaders understand `?cur=` (dashboard, analytics, returns list and each return's detail page). */
export const supportsCurrency = (pathname: string) => {
  const p = pathname.replace(/\/$/, "");
  return p === "/app" || p === "/app/analytics" || p === "/app/returns" || p.startsWith("/app/returns/");
};
