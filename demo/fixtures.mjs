// Synthetic responses for the demo, in the exact wire shapes the real sources
// parse. Nothing here was captured from a live service and no business, phone
// number, tender, price or article in it is real.
//
// Every trading name is an invented one, every phone number is inside the
// +91 98000 000xx block reserved here for the demo, and every URL points at
// example.test - a reserved TLD that resolves nowhere. The demo run is a real
// run of the real pipeline: the only thing replaced is the network.

export const SYNTHETIC = 'demo fixture - synthetic, not real data';

const node = (id, lat, lon, tags) => ({ type: 'node', id, lat, lon, tags });

/** An Overpass response: business listings, in OSM's own shape. */
export function overpassBody(group) {
  const byGroup = {
    food_service: [
      node(900000001, 12.9611, 77.6387, {
        name: 'Copper Lantern Kitchen',
        amenity: 'restaurant',
        cuisine: 'indian',
        phone: '+91 98000 00011',
        'addr:street': 'Demo Main Road',
        'addr:suburb': 'Indiranagar',
        website: 'https://copper-lantern.example.test',
      }),
      node(900000002, 12.9345, 77.6101, {
        name: 'Thali House',
        amenity: 'restaurant',
        phone: '+919800000012',
        'addr:suburb': 'Jayanagar',
      }),
      node(900000003, 12.9716, 77.5946, {
        name: 'Banquet Works Catering',
        craft: 'caterer',
        phone: '+91 98000 00013',
        'addr:suburb': 'Majestic',
      }),
      node(900000004, 12.9279, 77.6271, {
        name: 'The Food Arcade',
        amenity: 'food_court',
        'addr:suburb': 'Koramangala',
      }),
      node(900000005, 12.9082, 77.6476, {
        // Dropped during normalisation: the exclusion rule is part of the demo.
        name: 'Nightfall Cloud Kitchen',
        amenity: 'restaurant',
        phone: '+91 98000 00014',
      }),
    ],
    hospitality: [
      node(900000011, 12.9698, 77.6205, {
        name: 'Hotel Riverstone',
        tourism: 'hotel',
        stars: '4',
        phone: '+91 98000 00021',
        website: 'https://riverstone.example.test',
        'addr:suburb': 'Ulsoor',
      }),
      node(900000012, 12.9521, 77.7001, {
        name: 'Whitefield Grand',
        tourism: 'hotel',
        rooms: '180',
        phone: '+919800000022',
        'addr:suburb': 'Whitefield',
      }),
      node(900000013, 13.0106, 77.5551, {
        name: 'Yeshwanthpur Residency',
        tourism: 'hotel',
        phone: '+91 98000 00023',
      }),
    ],
    trade: [
      node(900000021, 12.9901, 77.5321, {
        name: 'Mandi Gate Wholesale',
        shop: 'wholesale',
        phone: '+91 98000 00031',
        'addr:street': 'Market Road',
        website: 'https://mandigate.example.test',
      }),
      node(900000022, 12.9433, 77.5812, {
        name: 'Daily Greens Grocers',
        shop: 'greengrocer',
        phone: '+919800000032',
      }),
      node(900000023, 12.9188, 77.6659, {
        name: 'Southside Supermarket',
        shop: 'supermarket',
        phone: '+91 98000 00033',
        'addr:suburb': 'HSR Layout',
      }),
      node(900000024, 13.0231, 77.6412, {
        name: 'Northgate Cash and Carry',
        shop: 'wholesale',
      }),
    ],
    industry: [
      node(900000031, 12.8881, 77.5108, {
        name: 'Clearwater Foods Processing',
        industrial: 'food',
        phone: '+91 98000 00041',
        website: 'https://clearwater-foods.example.test',
      }),
      node(900000032, 12.9004, 77.7302, {
        name: 'Peninsular Pickles and Pastes',
        industrial: 'food',
        phone: '+919800000042',
      }),
    ],
  };
  return JSON.stringify({
    version: 0.6,
    generator: 'demo fixture (synthetic)',
    osm3s: {
      timestamp_osm_base: '2026-09-11T00:00:00Z',
      copyright: 'Synthetic demo data in the shape of an Overpass response. Not OpenStreetMap data.',
    },
    elements: byGroup[group] || [],
  });
}

const item = (title, link, source, date) => `
    <item>
      <title>${title}</title>
      <link>${link}</link>
      <guid isPermaLink="false">${Buffer.from(link).toString('base64url')}</guid>
      <pubDate>${date}</pubDate>
      <source url="${source}">${source.replace(/^https?:\/\//, '')}</source>
    </item>`;

/** A Google News RSS response, in the feed's own shape. */
export function newsBody(query) {
  const items = {
    hotel: [
      item(
        'Riverstone group opens 120-room hotel in east Bengaluru - Demo Business Daily',
        'https://demo-business-daily.example.test/riverstone-opens',
        'https://demo-business-daily.example.test',
        'Tue, 09 Sep 2026 06:00:00 GMT'
      ),
    ],
    restaurant: [
      item(
        'Thali House to open four more outlets in Bengaluru this year - Demo Food Press',
        'https://demo-food-press.example.test/thali-house-expansion',
        'https://demo-food-press.example.test',
        'Mon, 08 Sep 2026 09:30:00 GMT'
      ),
    ],
    institution: [
      item(
        'Demo Institute of Technology invites tenders for hostel mess vegetable supply - Demo Civic Wire',
        'https://demo-civic-wire.example.test/dit-mess-tender',
        'https://demo-civic-wire.example.test',
        'Wed, 10 Sep 2026 04:15:00 GMT'
      ),
    ],
    wholesale: [
      item(
        'Wholesale vegetable arrivals steady at the Bengaluru market - Demo Trade Register',
        'https://demo-trade-register.example.test/arrivals-steady',
        'https://demo-trade-register.example.test',
        'Thu, 11 Sep 2026 03:00:00 GMT'
      ),
    ],
    food_manufacturer: [],
  };
  const seg = Object.keys(items).find((k) => query.includes(k)) || 'wholesale';
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>${SYNTHETIC}</title>
  <link>https://demo-news.example.test</link>
  ${(items[seg] || []).join('')}
</channel></rss>`;
}

/** A data.gov.in Agmarknet response, in the API's own record shape. */
export function agmarknetBody(commodity, state) {
  const modal = {
    Garlic: 14000,
    Capsicum: 3100,
    Tomato: 1600,
    Onion: 3500,
    Potato: 2200,
    Carrot: 2800,
    Cabbage: 1200,
    Beans: 4200,
    'Baby Corn': 5200,
    'Green Chilli': 3800,
  }[commodity];
  const records = modal
    ? [
        {
          state,
          district: 'Bangalore',
          market: 'Demo APMC Yard',
          commodity,
          variety: 'Other',
          arrival_date: '11/09/2026',
          min_price: String(Math.round(modal * 0.9)),
          max_price: String(Math.round(modal * 1.1)),
          modal_price: String(modal),
        },
      ]
    : [];
  return JSON.stringify({
    created: 1757000000,
    updated: 1757000000,
    desc: SYNTHETIC,
    count: records.length,
    total: records.length,
    records,
  });
}

// ------------------------------------------------------- the demand lane
//
// Two invented institutional buyers, each with a tender listing page and one
// notice. The listing pages deliberately differ in shape, because real ones do:
// one puts the subject in the anchor text, the other puts a bare "Download" link
// in a row whose text carries the subject. The notices are HTML rather than PDF
// so the demo needs no binary fixtures; the PDF path has its own tests.

const TENDER_PAGES = {
  'https://dit.example.test/tenders/': `<!doctype html><html><body>
    <h1>Tenders and Notices - Demo Institute of Technology</h1>
    <table>
      <tr><th>Ref</th><th>Subject</th><th>Closing</th><th></th></tr>
      <tr><td>DIT/2026/MS/14</td>
          <td><a href="/tenders/hostel-mess-vegetables-2026.html">Supply of fresh vegetables to the hostel mess, 2026-27</a></td>
          <td>30-09-2026</td><td></td></tr>
      <tr><td>DIT/2026/CIV/09</td>
          <td><a href="/tenders/roof-waterproofing.html">Roof waterproofing, Block C</a></td>
          <td>25-09-2026</td><td></td></tr>
      <tr><td>DIT/2026/IT/02</td>
          <td><a href="/tenders/network-switches.html">Supply of network switches</a></td>
          <td>28-09-2026</td><td></td></tr>
    </table></body></html>`,

  'https://hospital.example.test/notices/': `<!doctype html><html><body>
    <h1>Procurement notices</h1>
    <table>
      <tr><td>DCGH/DIET/2026/03</td>
          <td>Annual rate contract for hospital diet vegetables</td>
          <td>Closing 22-09-2026</td>
          <td><a href="/notices/diet-vegetables-2026.html">Download</a></td></tr>
      <tr><td>DCGH/ENG/2026/11</td>
          <td>Servicing of standby generators</td>
          <td>Closing 19-09-2026</td>
          <td><a href="/notices/generators.html">Download</a></td></tr>
    </table></body></html>`,
};

const NOTICES = {
  'https://dit.example.test/tenders/hostel-mess-vegetables-2026.html': `<!doctype html><html><body>
    <p>Demo Institute of Technology, Demo Campus Road, Bengaluru - 560100</p>
    <h2>NOTICE INVITING TENDER - DIT/2026/MS/14, dated 05.09.2026</h2>
    <p>Sealed tenders are invited from eligible suppliers for the supply of fresh
    vegetables, including peeled garlic, to the hostel mess for the academic year
    2026-27.</p>
    <p>Estimated requirement: 1,500 kg vegetables per month.</p>
    <p>Last date for submission of bids: 30-09-2026 at 15:00 hrs.</p>
    <p>Contact Person: Dr. A. N. Rao, Deputy Registrar (Stores)</p>
    <p>Phone: 080-2900 1100 &nbsp; Email: stores [at] dit [dot] example [dot] test</p>
    <p>In case of any difficulty in submitting the bid online, contact the
    e-procurement helpdesk at helpdesk@eproc.example.test.</p>
    </body></html>`,

  'https://hospital.example.test/notices/diet-vegetables-2026.html': `<!doctype html><html><body>
    <p>Demo City General Hospital, Bengaluru - 560002</p>
    <h2>Annual rate contract: hospital diet vegetables (DCGH/DIET/2026/03)</h2>
    <p>Quotations are invited for the supply of vegetables for patient diet for
    the period 2026-27. Approximate quantity: 40 quintals per month.</p>
    <p>Closing date: 22-09-2026</p>
    <p>Contact: The Chief Dietician, Demo City General Hospital.</p>
    </body></html>`,
};

/** The two demo institutions' pages, or null when the URL is not one of them. */
export function institutionBody(url) {
  const clean = url.split('#')[0];
  return TENDER_PAGES[clean] ?? NOTICES[clean] ?? null;
}

/** Every host the demand-lane fixtures serve, for the robots.txt answer. */
export const DEMO_HOSTS = ['dit.example.test', 'hospital.example.test'];
