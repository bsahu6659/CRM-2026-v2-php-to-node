# Free demo hosting

| Part | Service | Free plan notes |
| --- | --- | --- |
| Database | **TiDB Cloud Starter** (MySQL-compatible) | No card needed; storage quota per instance |
| Node API | **Render** free web service | Sleeps after 15 min idle; ~1 min to wake; uploads are lost on restart |
| React app | **Netlify** (or Vercel) | Forwards `/api`, `/webhooks`, `/f`, `/embed` to Render |

The React site forwards the API paths to Render, so the browser only ever
talks to one address and the login cookie keeps working in every browser.

Do the steps in this order: each one needs an address from the one before.

---

## 1. Put the code on GitHub

Create an empty **private** repository on github.com (no README), then from
the project folder:

```bash
git init
git add .
git commit -m "Growvanta CRM"
git branch -M main
git remote add origin https://github.com/YOUR-NAME/growvanta-crm-node.git
git push -u origin main
```

`.env`, `.env.tidb`, `.dev/` (the local MySQL) and `node_modules` are
git-ignored, so no password or local database is uploaded. Check with
`git status` before the first commit if unsure.

## 2. TiDB Cloud: create the database

1. Sign up at **tidbcloud.com** and create a **Starter** cluster (any AWS region near you).
2. Open the cluster → **Connect** → *Connect With: General* → **Generate Password**.
3. Note the four values it shows: **host**, **port** (4000), **user** (looks like `xxxxxxxx.root`) and **password**.

## 3. Your computer: create the tables and demo logins in TiDB

```bash
cd server
cp .env.tidb.example .env.tidb
```

Open `server/.env.tidb` and fill in `DB_HOST`, `DB_USER`, `DB_PASS` from
step 2, and a new `SEED_PASSWORD` for the demo logins. Then:

```bash
ENV_FILE=.env.tidb npm run migrate
ENV_FILE=.env.tidb npm run seed -- --demo
```

`migrate` creates the `growvanta` database and its tables. `seed` creates
`superadmin@growvanta.com` and `admin@demorealty.test`, both with your
`SEED_PASSWORD`. (Run `nvm use` first if your terminal's Node is older than 20.)

## 4. Render: deploy the Node API

1. Sign up at **render.com** with GitHub.
2. **New → Blueprint** → pick the repository. Render reads `render.yaml`.
3. It asks for these values:

   | Key | Value |
   | --- | --- |
   | `DB_HOST`, `DB_USER`, `DB_PASS` | From TiDB (step 2) |
   | `APP_URL`, `CLIENT_URL`, `CORS_ORIGINS` | Not known yet: enter `https://example.com` for now, fixed in step 6 |

4. **Apply**. When the deploy is live, open
   `https://YOUR-SERVICE.onrender.com/api/health` — it should say
   `"database":"up"`. Copy that `https://….onrender.com` address.

## 5. Netlify: deploy the React app

1. Sign up at **netlify.com** with GitHub.
2. **Add new site → Import an existing project** → pick the repository.
   `netlify.toml` already sets the folder, build command and publish folder.
3. Before deploying, add one environment variable:
   `API_ORIGIN` = the Render address from step 4 (no trailing slash).
4. **Deploy**. Optionally rename the site (Site configuration → Change site name).
   Copy the final `https://….netlify.app` address.

## 6. Render: put in the real site address

Render → your service → **Environment** → set all three to the Netlify
address from step 5, then **Save** (Render redeploys by itself):

`APP_URL`, `CLIENT_URL`, `CORS_ORIGINS`

## 7. Open the demo

Open the Netlify address and sign in with `admin@demorealty.test` (or the
super admin) and your `SEED_PASSWORD`.

**Before showing it to anyone**, open the Render `/api/health` address once and
wait for it to answer: a sleeping free service takes about a minute to wake,
and the first page load may fail while it does.

---

## Using Vercel instead of Netlify

1. Replace every `YOUR-API.onrender.com` in `client/vercel.json` with your
   Render address, commit and push.
2. vercel.com → **Add New → Project** → pick the repository → **Root Directory:
   `client`** → Deploy.
3. Do step 6 with the `https://….vercel.app` address.

## Limits of the free setup

- **Wake-up delay:** Render sleeps after 15 minutes without traffic.
- **Uploads are temporary:** documents, project photos and logos disappear when
  the Render service restarts or sleeps; Render's free plan has no permanent disk.
- **Email is off:** no SMTP is configured, so invites and password resets are
  only written to Render's log. Add `SMTP_*` keys in Render to send real mail.
- **TiDB is MySQL-compatible, not MySQL:** if a screen errors with a database
  message, check Render's log.
- **Meta lead ads** need `META_*` keys and the Meta app pointed at
  `https://YOUR-SITE.netlify.app/webhooks/meta_leads.php`.
