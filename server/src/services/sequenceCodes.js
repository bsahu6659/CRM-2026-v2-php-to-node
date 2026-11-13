/**
 * Human-readable record codes (LD-1042, OPP-1043) — port of
 * services/SequenceCodes.php. A single monotonic counter per organisation
 * backs every prefix.
 *
 * Why the transaction: the PHP edition ran the UPDATE and the SELECT on its one
 * PDO handle, so the read always saw its own increment. From a connection pool
 * the two statements could land on different connections, and a concurrent
 * increment slipping between them would hand two leads the same code. Inside
 * dbTransaction both run on one connection, and the UPDATE's row lock holds
 * until the value has been read back. Called from inside an outer transaction
 * (createLead), it simply joins that one.
 */

import { dbExec, dbScalar, dbTransaction } from '../lib/db.js';

export async function nextCode(orgId, prefix) {
  return dbTransaction(async () => {
    await dbExec('UPDATE organizations SET lead_seq = lead_seq + 1 WHERE id = ?', [orgId]);
    const seq = Math.trunc(Number(await dbScalar('SELECT lead_seq FROM organizations WHERE id = ?', [orgId])) || 0);
    return `${prefix}-${seq}`;
  });
}

export async function nextCodeBlock(orgId, prefix, count) {
  return dbTransaction(async () => {
    await dbExec('UPDATE organizations SET lead_seq = lead_seq + ? WHERE id = ?', [count, orgId]);
    const end = Math.trunc(Number(await dbScalar('SELECT lead_seq FROM organizations WHERE id = ?', [orgId])) || 0);
    const start = end - count + 1;
    const codes = [];
    for (let i = 0; i < count; i++) {
      codes.push(`${prefix}-${start + i}`);
    }
    return codes;
  });
}
