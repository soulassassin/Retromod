import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(__dirname, '..', 'fixtures');

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function renderOgPage({ title, description, image, url, type = 'article' }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(title)}</title>
  <meta property="og:type" content="${escapeHtml(type)}">
  <meta property="og:title" content="${escapeHtml(title)}">
  <meta property="og:description" content="${escapeHtml(description)}">
  <meta name="description" content="${escapeHtml(description)}">
  ${image ? `<meta property="og:image" content="${escapeHtml(image)}">` : ''}
  <meta property="og:url" content="${escapeHtml(url)}">
</head>
<body>
  <main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(description)}</p></main>
</body>
</html>`;
}

export async function startMockInstagram() {
  const sampleJpg = fs.readFileSync(path.join(FIXTURES_DIR, 'valid-sample.jpg'));
  const samplePng = fs.readFileSync(path.join(FIXTURES_DIR, 'valid-sample.png'));
  const requestLog = [];

  let baseUrl = '';

  const server = http.createServer((req, res) => {
    const reqUrl = new URL(req.url || '/', 'http://127.0.0.1');
    const pathname = reqUrl.pathname;
    requestLog.push({
      method: req.method,
      url: pathname,
      userAgent: req.headers['user-agent'] || ''
    });

    if (pathname === '/retromod.za/p/DfnNewAudio1/' || pathname === '/retromod.za/p/DfnNewAudio1') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        renderOgPage({
          title: '@retromod.za on Instagram: "Technics SL-1200MK2 Direct-Drive Turntable — Japan, 1984. R12 500"',
          description:
            'Technics SL-1200MK2 Direct-Drive Turntable — Japan, 1984. Category: Audio. R12 500. Quartz-locked pitch fader, fresh Ortofon stylus. #technics #retromod #hifi',
          image: `${baseUrl}/media/technics-1200.jpg`,
          url: `${baseUrl}/retromod.za/p/DfnNewAudio1/`
        })
      );
      return;
    }

    if (pathname === '/retromod.za/p/DfnNewFurn2/' || pathname === '/retromod.za/p/DfnNewFurn2') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        renderOgPage({
          title: '@retromod.za on Instagram: "Danish Teak Credenza by Arne Vodder — Denmark, 1965. R16 800"',
          description:
            'Danish Teak Credenza by Arne Vodder — Denmark, 1965. Category: Furniture. R16 800. Sliding doors, sculpted pulls, restored oil finish.',
          image: `${baseUrl}/media/teak-credenza.png`,
          url: `${baseUrl}/retromod.za/p/DfnNewFurn2/`
        })
      );
      return;
    }

    if (pathname === '/retromod.za/p/DfnF8-nkdJi/' || pathname === '/retromod.za/p/DfnF8-nkdJi') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        renderOgPage({
          title: '@retromod.za on Instagram: "Marantz Model Twenty Nine Stereo Receiver — USA / Japan, 1972. R6 950"',
          description:
            'Marantz Model Twenty Nine Stereo Receiver — USA / Japan, 1972. Category: Audio. R6 950. Qty: 2 available. Serviced and bench tested.',
          image: `${baseUrl}/media/marantz-29.jpg`,
          url: `${baseUrl}/retromod.za/p/DfnF8-nkdJi/`
        })
      );
      return;
    }

    if (pathname === '/retromod.za/p/DfnSoldItem3/' || pathname === '/retromod.za/p/DfnSoldItem3') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        renderOgPage({
          title: '@retromod.za on Instagram: "Braun SK4 Snow White Turntable — Germany, 1956. SOLD"',
          description:
            'Braun SK4 Snow White Turntable by Dieter Rams — Germany, 1956. SOLD — R14 000. Category: Audio.',
          image: `${baseUrl}/media/braun-sk4.jpg`,
          url: `${baseUrl}/retromod.za/p/DfnSoldItem3/`
        })
      );
      return;
    }

    if (pathname === '/retromod.za/reel/DfnReelInfo/' || pathname === '/retromod.za/reel/DfnReelInfo') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        renderOgPage({
          type: 'video',
          title: '@retromod.za on Instagram: "Weekend showroom hours"',
          description:
            'Weekend showroom hours at 66 Grant Ave, Norwood! Pop in Saturday 9am-2pm. #norwood #retromod',
          image: `${baseUrl}/media/technics-1200.jpg`,
          url: `${baseUrl}/retromod.za/reel/DfnReelInfo/`
        })
      );
      return;
    }

    if (pathname === '/retromod.za/p/DfnLoginWall/' || pathname === '/retromod.za/p/DfnLoginWall') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html><head><title>Login • Instagram</title></head><body><h1>Log in to Instagram</h1></body></html>');
      return;
    }

    if (pathname === '/retromod.za/p/DfnBadImg/' || pathname === '/retromod.za/p/DfnBadImg') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        renderOgPage({
          title: '@retromod.za on Instagram: "B&O Beolit 600 Radio — R3 200"',
          description: 'B&O Beolit 600 Radio — Denmark, 1970. Category: Audio. R3 200.',
          image: `${baseUrl}/media/missing.jpg`,
          url: `${baseUrl}/retromod.za/p/DfnBadImg/`
        })
      );
      return;
    }

    if (pathname === '/retromod.za/p/DfnCorruptImg/' || pathname === '/retromod.za/p/DfnCorruptImg') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        renderOgPage({
          title: '@retromod.za on Instagram: "Philips N4504 Reel Deck — R4 100"',
          description: 'Philips N4504 Reel Deck — Netherlands, 1977. Category: Audio. R4 100.',
          image: `${baseUrl}/media/corrupt.jpg`,
          url: `${baseUrl}/retromod.za/p/DfnCorruptImg/`
        })
      );
      return;
    }

    if (
      pathname === '/media/technics-1200.jpg' ||
      pathname === '/media/braun-sk4.jpg' ||
      pathname === '/media/marantz-29.jpg'
    ) {
      res.writeHead(200, {
        'Content-Type': 'image/jpeg',
        'Content-Length': String(sampleJpg.length)
      });
      res.end(sampleJpg);
      return;
    }

    if (pathname === '/media/teak-credenza.png') {
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Content-Length': String(samplePng.length)
      });
      res.end(samplePng);
      return;
    }

    if (pathname === '/media/corrupt.jpg') {
      const html = '<html><body>not an image</body></html>';
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': String(Buffer.byteLength(html))
      });
      res.end(html);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;

  return {
    port,
    baseUrl,
    requestLog,
    urls: {
      newAudio: `${baseUrl}/retromod.za/p/DfnNewAudio1/`,
      newFurniture: `${baseUrl}/retromod.za/p/DfnNewFurn2/`,
      existingMarantz: `${baseUrl}/retromod.za/p/DfnF8-nkdJi/`,
      soldBraun: `${baseUrl}/retromod.za/p/DfnSoldItem3/`,
      nonProductReel: `${baseUrl}/retromod.za/reel/DfnReelInfo/`,
      loginWall: `${baseUrl}/retromod.za/p/DfnLoginWall/`,
      badImagePost: `${baseUrl}/retromod.za/p/DfnBadImg/`,
      corruptImagePost: `${baseUrl}/retromod.za/p/DfnCorruptImg/`,
      notFoundPost: `${baseUrl}/retromod.za/p/Dfn404Missing/`,
      validJpg: `${baseUrl}/media/technics-1200.jpg`,
      validPng: `${baseUrl}/media/teak-credenza.png`,
      corruptJpg: `${baseUrl}/media/corrupt.jpg`,
      missingJpg: `${baseUrl}/media/missing.jpg`
    },
    async close() {
      await new Promise((resolve) => server.close(() => resolve()));
    }
  };
}
