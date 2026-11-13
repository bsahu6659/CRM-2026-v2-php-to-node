import { Outlet } from 'react-router-dom';

/**
 * Split screen for every unauthenticated page: brand panel on the left, the
 * form on the right. The panel is hidden below 900px by the design system, so
 * the form gets the whole viewport on a phone.
 */
export default function AuthLayout() {
  return (
    <div className="auth-page">
      <aside className="auth-aside">
        <div className="row" style={{ gap: 11 }}>
          <img
            className="brand-lockup"
            src="/assets/logo-full-dark.png"
            srcSet="/assets/logo-full-dark.png 1x, /assets/logo-full-dark@2x.png 2x"
            alt="Growvanta"
            width="168"
            height="72"
          />
        </div>

        <div>
          <div className="a-quote">
            Every lead accounted for. Every follow-up on time. Every number traced back to a campaign.
          </div>
          <div className="a-list">
            <div>
              <span>◆</span>
              <span>Capture leads from forms, ads, WhatsApp and your own API.</span>
            </div>
            <div>
              <span>◆</span>
              <span>Route them automatically by source, territory or product.</span>
            </div>
            <div>
              <span>◆</span>
              <span>Track the whole lifecycle to closed-won revenue.</span>
            </div>
            <div>
              <span>◆</span>
              <span>Give every manager exactly the visibility their role allows.</span>
            </div>
          </div>
        </div>

        <div style={{ fontSize: '12.5px', color: '#8fa3b3', position: 'relative' }}>
          Multi-tenant · Role-based access · Full audit trail
        </div>
      </aside>

      <main className="auth-main">
        <div className="auth-box">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
