import { ImageResponse } from 'next/og';

// GET /api/og/cart-image?src=<product image url>
//
// The header picture for the abandoned-cart WhatsApp reminder: the
// product photo on white with the Hindrishi logo in a band along the
// bottom. WhatsApp templates carry only one header image, so the logo
// is composited into it. Only Shopify CDN images are accepted, so this
// can't be used to proxy arbitrary URLs.

const SIZE = 1080;
const BAND = 170;
const DEFAULT_LOGO =
  'https://cdn.shopify.com/s/files/1/0291/4149/9956/files/Logo.png?v=1714537623';

function allowed(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && u.hostname === 'cdn.shopify.com'
      ? u.toString()
      : null;
  } catch {
    return null;
  }
}

/** Fetch an image as a data URL, asking for JPEG/PNG (Satori can't read WebP). */
async function dataUrl(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { accept: 'image/jpeg,image/png;q=0.9' },
      next: { revalidate: 86400 },
    });
    if (!res.ok) return null;
    const type = res.headers.get('content-type') ?? 'image/jpeg';
    if (!/image\/(jpeg|png)/.test(type)) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return `data:${type};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const src = allowed(params.get('src'));
  const logoUrl = process.env.CART_REMINDER_LOGO_URL || DEFAULT_LOGO;
  const [product, logo] = await Promise.all([
    src ? dataUrl(src) : Promise.resolve(null),
    dataUrl(logoUrl),
  ]);

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          backgroundColor: '#ffffff',
        }}
      >
        <div
          style={{
            display: 'flex',
            flexGrow: 1,
            alignItems: 'center',
            justifyContent: 'center',
            padding: 40,
          }}
        >
          {product ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={product}
              alt=""
              width={SIZE - 80}
              height={SIZE - BAND - 80}
              style={{ objectFit: 'contain' }}
            />
          ) : null}
        </div>
        <div
          style={{
            display: 'flex',
            height: BAND,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: '#0b0b0b',
            overflow: 'hidden',
          }}
        >
          {logo ? (
            // The logo file is a square with the mark in its middle;
            // a wide crop of it keeps just the wordmark.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={logo}
              alt=""
              width={520}
              height={BAND}
              style={{ objectFit: 'cover' }}
            />
          ) : (
            <div style={{ display: 'flex', color: '#d4a32a', fontSize: 64 }}>
              Hindrishi Ayurveda
            </div>
          )}
        </div>
      </div>
    ),
    {
      width: SIZE,
      height: SIZE,
      headers: { 'cache-control': 'public, max-age=86400, immutable' },
    }
  );
}
