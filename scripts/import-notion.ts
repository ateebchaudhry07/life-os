/** CLI version of Settings → "Import from Notion". Usage: NOTION_TOKEN=... DATABASE_URL=... npm run import:notion */
import { importNotion } from "../src/lib/importNotion";
import { db } from "../src/lib/db";

importNotion()
  .then((msg) => console.log(msg))
  .catch((e) => { console.error(e.message); process.exit(1); })
  .finally(() => db.$disconnect());
