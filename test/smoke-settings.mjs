import { executeQuery } from '../src/lib/db.js';

async function run() {
  const res = await executeQuery('SELECT * FROM va_controlled_transition');
  console.log(JSON.stringify(res, null, 2));
}
run().catch(console.error);
