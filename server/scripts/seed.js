/**
 * Creates the platform tier and, optionally, a demo tenant.
 *
 *   npm run seed                 # platform owner only
 *   npm run seed -- --demo       # plus a demo client company with sample users
 *
 * Safe to re-run: every step checks for its own result first.
 *
 * On a live install the shared SEED_PASSWORD default must never become the
 * platform owner's password — it ships in .env.example, so it is public. When
 * nothing is supplied outside development, a random one is minted and printed
 * once.
 */

import crypto from 'node:crypto';
import config from '../src/config/index.js';
import { closePool, dbExec, dbOne, dbScalar } from '../src/lib/db.js';
import { hashPassword } from '../src/lib/security.js';
import { gvId, normalizeEmail } from '../src/lib/util.js';
import { provisionClient, provisionOrganization } from '../src/services/provisioning.js';

/** Readable but unguessable: ambiguous characters left out on purpose. */
function randomPassword(length = 18) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789@#%+=';
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[crypto.randomInt(0, alphabet.length)];
  return out;
}

async function main() {
  const wantDemo = process.argv.includes('--demo');

  let generated = false;
  let password = String(process.env.SUPER_ADMIN_PASSWORD ?? '');
  if (password === '') {
    if (['local', 'development', 'test'].includes(config.env)) {
      password = config.seedPassword;
    } else {
      password = randomPassword();
      generated = true;
    }
  }
  const email = normalizeEmail(process.env.SUPER_ADMIN_EMAIL ?? 'superadmin@growvanta.com');

  console.log('Growvanta platform bootstrap');
  console.log('-'.repeat(60));

  // -------------------------------------------------------------------------
  // 1. The platform organisation
  // -------------------------------------------------------------------------
  let platformId = await dbScalar('SELECT id FROM organizations WHERE is_platform = 1 LIMIT 1');

  if (platformId) {
    console.log(`  platform organisation already exists (${platformId})`);
  } else {
    const prov = await provisionOrganization('Growvanta Platform', 'growvanta-platform', 'INR', 'Asia/Kolkata', {
      isPlatform: true,
      companyType: 'AGENCY',
      legalName: 'Growvanta Platform',
    });
    platformId = prov.organizationId;
    console.log(`✓ platform organisation created (${platformId})`);
  }

  // -------------------------------------------------------------------------
  // 2. The Super Admin
  // -------------------------------------------------------------------------
  const superRoleId = await dbScalar(
    "SELECT id FROM roles WHERE organization_id = ? AND `key` = 'super_admin' LIMIT 1",
    [platformId]
  );
  if (!superRoleId) {
    throw new Error('The platform organisation has no super_admin role — provisioning did not complete.');
  }

  const existingUser = await dbOne('SELECT id, is_platform_admin FROM users WHERE email = ?', [email]);
  if (existingUser) {
    // Never silently reset a password that is already in use.
    await dbExec('UPDATE users SET is_platform_admin = 1, role_id = ?, organization_id = ? WHERE id = ?', [
      superRoleId,
      platformId,
      existingUser.id,
    ]);
    console.log(`  super admin already exists (${email}) — password left unchanged`);
  } else {
    await dbExec(
      `INSERT INTO users
         (id, organization_id, role_id, first_name, last_name, email, password_hash,
          job_title, designation, is_active, is_platform_admin, email_verified_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,1,1,NOW(),NOW(),NOW())`,
      [gvId(), platformId, superRoleId, 'Platform', 'Owner', email, await hashPassword(password), 'Super Admin', 'Super Admin']
    );
    console.log(`✓ super admin created: ${email}`);
    if (generated) {
      console.log('');
      console.log('  ┌───────────────────────────────────────────────────────┐');
      console.log('  │ This password is shown once. Store it now.            │');
      console.log('  └───────────────────────────────────────────────────────┘');
      console.log(`  password: ${password}`);
      console.log('');
    } else {
      console.log(`  password: (from SEED_PASSWORD / SUPER_ADMIN_PASSWORD)`);
    }
  }

  // -------------------------------------------------------------------------
  // 3. Existing tenants get a company type
  // -------------------------------------------------------------------------
  const untyped = await dbExec(
    "UPDATE organizations SET company_type = 'DEVELOPER' WHERE is_platform = 0 AND (company_type IS NULL OR company_type = '')"
  );
  if (untyped) console.log(`  ${untyped} existing tenant(s) typed as DEVELOPER`);

  // -------------------------------------------------------------------------
  // 4. Demo tenant (opt-in)
  // -------------------------------------------------------------------------
  if (wantDemo) {
    const demoEmail = 'admin@demorealty.test';
    if (await dbOne('SELECT id FROM users WHERE email = ?', [demoEmail])) {
      console.log(`  demo tenant already exists (${demoEmail})`);
    } else {
      const demo = await provisionClient({
        companyName: 'Demo Realty',
        companyType: 'DEVELOPER',
        adminName: 'Demo Admin',
        adminEmail: demoEmail,
        password: config.seedPassword,
        city: 'Gurugram',
        state: 'Haryana',
        country: 'India',
      });
      console.log(`✓ demo tenant created: ${demoEmail} / ${config.seedPassword}  (org ${demo.organizationId})`);
    }
  }

  console.log('\nDone.');
}

main()
  .then(closePool)
  .catch(async (err) => {
    console.error('\n[seed] failed:', err.message);
    await closePool();
    process.exit(1);
  });
