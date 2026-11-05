import type { Metadata } from 'next'

// Public privacy policy for Waygenext's WhatsApp messaging (needed by Meta
// to publish the Waygenext Messaging app). Not behind login.

export const metadata: Metadata = {
  title: 'Waygenext – Privacy Policy',
  robots: { index: true, follow: true },
}

const UPDATED = '5 November 2026'
const CONTACT = 'vipul.waygenext@gmail.com'

export default function WaygenextPrivacyPage() {
  return (
    <main className="mx-auto max-w-2xl px-4 py-12 text-sm leading-6">
      <h1 className="mb-1 text-2xl font-semibold">Privacy Policy</h1>
      <p className="mb-8 text-muted-foreground">
        Waygenext Technologies · Last updated {UPDATED}
      </p>

      <section className="space-y-4">
        <p>
          Waygenext Technologies (&quot;Waygenext&quot;, &quot;we&quot;) helps people buy, sell and rent
          residential and commercial property. This policy explains what information we collect
          when you contact us or receive messages from us on WhatsApp, and how we use it.
        </p>

        <h2 className="pt-2 text-base font-semibold">Information we collect</h2>
        <ul className="list-disc space-y-1 pl-5">
          <li>Your name and WhatsApp phone number.</li>
          <li>Messages you send us, and your property requirements (location, budget, type).</li>
          <li>Basic delivery information from WhatsApp (whether a message was delivered or read).</li>
        </ul>

        <h2 className="pt-2 text-base font-semibold">How we use it</h2>
        <ul className="list-disc space-y-1 pl-5">
          <li>To reply to your enquiries and share property options you asked about.</li>
          <li>To arrange site visits, calls and follow-ups.</li>
          <li>To send updates about properties, only if you have agreed to hear from us.</li>
        </ul>

        <h2 className="pt-2 text-base font-semibold">Sharing</h2>
        <p>
          We do not sell your information. We share it only with property owners or developers
          when you ask us to connect you, with service providers that help us run our messaging
          (such as Meta&apos;s WhatsApp Business Platform and our CRM hosting), or when required by law.
        </p>

        <h2 className="pt-2 text-base font-semibold">Your choices</h2>
        <p>
          You can stop receiving messages at any time by replying <strong>STOP</strong> on WhatsApp.
          You can ask us to see, correct or delete your information by writing to{' '}
          <a className="underline" href={`mailto:${CONTACT}`}>{CONTACT}</a>.
        </p>

        <h2 className="pt-2 text-base font-semibold">Retention and security</h2>
        <p>
          We keep your information only as long as needed for the purposes above, and protect it
          with access controls and encryption of stored credentials.
        </p>

        <h2 className="pt-2 text-base font-semibold">Data deletion</h2>
        <p>
          To delete your data, email <a className="underline" href={`mailto:${CONTACT}`}>{CONTACT}</a>{' '}
          with your WhatsApp number. We delete it within 30 days and confirm by email.
        </p>

        <h2 className="pt-2 text-base font-semibold">Contact</h2>
        <p>
          Questions about this policy: <a className="underline" href={`mailto:${CONTACT}`}>{CONTACT}</a>.
        </p>
      </section>
    </main>
  )
}
