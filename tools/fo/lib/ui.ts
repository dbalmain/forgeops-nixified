const ESC = "\x1b[";
const useColour = Boolean(process.stdout.isTTY) && !process.env["NO_COLOR"];
const c = (code: string) => (s: string) =>
  useColour ? `${ESC}${code}m${s}${ESC}0m` : s;

export const dim = c("2");
export const bold = c("1");
export const red = c("31");
export const green = c("32");
export const yellow = c("33");
export const cyan = c("36");

export function step(msg: string): void {
  console.log(`${cyan("=>")} ${msg}`);
}

export function detail(msg: string): void {
  console.log(`   ${dim(msg)}`);
}

export function ok(msg: string): void {
  console.log(`   ${green("ok")} ${msg}`);
}

export function warn(msg: string): void {
  console.log(`   ${yellow("!!")} ${msg}`);
}

export function fail(msg: string): void {
  console.log(`   ${red("XX")} ${msg}`);
}

export function heading(msg: string): void {
  console.log(`\n${bold(msg)}`);
}

export function die(msg: string): never {
  console.error(`\n${red("error")} ${msg}`);
  process.exit(1);
}

export function table(rows: Array<[string, string]>, indent = "   "): void {
  if (rows.length === 0) return;
  const w = Math.max(...rows.map(([k]) => k.length));
  for (const [k, v] of rows) console.log(`${indent}${k.padEnd(w)}  ${v}`);
}
