import { extractText, getDocumentProxy } from "unpdf";

export type StatementRow = { date: string; desc: string; signed: number };

const toNum = (s: string) => {
  const neg = /^\(|\)$|-$|^-/.test(s.replace(/\$/g, ""));
  const n = Number(s.replace(/[()$,-]/g, ""));
  return neg ? -n : n;
};

/**
 * Read a bank statement PDF without AI (built against Flagstar: "Post Date | Description | Debits | Credits | Balance").
 * The text is split at each full date; every chunk ending in an amount and a running balance is a transaction, and the
 * change in balance says whether it was money in or out, so wrapped descriptions and column layout don't matter.
 */
export async function parseStatementText(pdf: Uint8Array): Promise<StatementRow[]> {
  const { text } = await extractText(await getDocumentProxy(pdf), { mergePages: true });
  const flat = (Array.isArray(text) ? text.join(" ") : text)
    .replace(/Statement Ending \d{2}\/\d{2}\/\d{4}.*?(?:Post Date Description Debits Credits Balance|$)/g, " ") // page footers + next page header
    .replace(/\s+/g, " ");
  const chunks = flat.split(/(?=\b\d{2}\/\d{2}\/\d{4}\b)/);
  const out: StatementRow[] = [];
  let prev: number | null = null;
  for (const chunk of chunks) {
    const m = chunk.match(/^(\d{2})\/(\d{2})\/(\d{4}) (.*)$/);
    if (!m) continue;
    const [, mm, dd, yyyy, rest] = m;
    if (/^Beginning Balance/i.test(rest)) { const b = rest.match(/\$?[\d,]+\.\d{2}/); if (b) prev = toNum(b[0]); continue; }
    if (/^Ending Balance/i.test(rest)) continue;
    // "<description> $8.00 $1,056.09": the last two amounts are the transaction and the new balance.
    const t = rest.match(/^(.*?)\s+(-?\$[\d,]+\.\d{2})\s+(-?\$[\d,]+\.\d{2})(?:\s|$)/);
    if (!t) continue;
    const desc = t[1].trim(), amount = toNum(t[2]), balance = toNum(t[3]);
    let signed: number;
    if (prev !== null && Math.abs(Math.abs(balance - prev) - amount) < 0.005) signed = Math.round((balance - prev) * 100) / 100;
    else signed = /deposit|credit|refund|interest/i.test(desc) ? amount : -amount;
    prev = balance;
    out.push({ date: `${yyyy}-${mm}-${dd}`, desc, signed });
  }
  return out;
}
