import Link from 'next/link';

export default function RootNotFound() {
  return (
    <main className="login-wrap global-error-wrap">
      <section className="login-card global-error-card">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/images/brand/genesys-logo.svg"
          alt="Genesys"
          className="brand-logo"
          width={160}
          height={30}
        />
        <span className="state-code">404 · Not found</span>
        <h1>That page does not exist</h1>
        <p className="login-lede">
          The address may be incomplete, or the resource may no longer be available.
        </p>
        <Link className="btn-link-primary" href="/">
          Return to AVA Observability
        </Link>
      </section>
    </main>
  );
}
