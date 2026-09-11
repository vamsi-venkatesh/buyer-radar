// SYNTHETIC FIXTURES - every page below was written for this harness.
//
// None of it was captured from a real website, none of the businesses exist,
// and none of the phone numbers, tonnages, tender numbers or dates describe
// anything real. They are written to read like the pages the radar actually
// meets - a wholesaler's one-page site, a hotel's about page, a tender notice,
// a news item, and a couple of pages that are not about a business at all - so
// the prompt is scored on the shapes it will see. They must never be shown as
// real data, and nothing here may be copied into a lead.
//
// `expect` is the label: what a careful reader would answer from this text
// alone. Where the text genuinely does not say, the label is `unknown` or
// `null`, and answering `unknown` is the correct answer, not a failure.

export const SYNTHETIC = true;

export const CASES = [
  {
    id: 'fx01-wholesale-large',
    name: 'Sri Lakshmi Vegetables',
    city: 'Bengaluru',
    url: 'https://example.invalid/srilakshmi/',
    expect: { segment: 'wholesale', size: 'large', deadline: null },
    html: `<h1>Sri Lakshmi Vegetables</h1>
      <p>Wholesale vegetable traders at Kalasipalya market since 1994. We move 35 to 40 tonnes of
      vegetables every day to hotels, caterers and retailers across Bengaluru.</p>
      <p>Daily arrivals: onion, potato, tomato, garlic, ginger, green chilli.</p>
      <p>Counters: 4. Staff: 60. Loading from 4 a.m.</p>`,
  },
  {
    id: 'fx02-wholesale-small',
    name: 'Anjaneya Traders',
    city: 'Bengaluru',
    url: 'https://example.invalid/anjaneya/',
    expect: { segment: 'wholesale', size: 'small', deadline: null },
    html: `<h1>Anjaneya Traders</h1>
      <p>Single wholesale counter at Yeshwanthpur APMC. Father and two sons. We sell onion and
      potato by the sack to nearby shops.</p>
      <p>Open 5 a.m. to 11 a.m.</p>`,
  },
  {
    id: 'fx03-wholesale-medium',
    name: 'Nandi Fresh Mandi',
    city: 'Bengaluru',
    url: 'https://example.invalid/nandifresh/',
    expect: { segment: 'wholesale', size: 'medium', deadline: null },
    html: `<h1>Nandi Fresh Mandi</h1>
      <p>Wholesale supply of fresh vegetables to the south Bengaluru trade. Two godowns, 18 staff,
      about 6 tonnes handled a day.</p>
      <p>We buy directly from growers in Kolar and Chikkaballapur.</p>`,
  },
  {
    id: 'fx04-restaurant-small',
    name: 'Udupi Tiffin Room',
    city: 'Bengaluru',
    url: 'https://example.invalid/udupitiffin/',
    expect: { segment: 'restaurant', size: 'small', deadline: null },
    html: `<h1>Udupi Tiffin Room</h1>
      <p>A 32-seat vegetarian tiffin room in Basavanagudi. Idli, dosa, khara bath, filter coffee.</p>
      <p>One kitchen, open 6.30 a.m. to 9 p.m. Family run.</p>`,
  },
  {
    id: 'fx05-restaurant-medium',
    name: 'Chulha House',
    city: 'Bengaluru',
    url: 'https://example.invalid/chulhahouse/',
    expect: { segment: 'restaurant', size: 'medium', deadline: null },
    html: `<h1>Chulha House</h1>
      <p>North Indian kitchen with three outlets in Bengaluru - Indiranagar, HSR Layout and
      Rajajinagar. About 300 covers a day across the three.</p>
      <p>Our central kitchen preps vegetables every morning for all three outlets.</p>`,
  },
  {
    id: 'fx06-restaurant-large',
    name: 'Coastal Bowl',
    city: 'Bengaluru',
    url: 'https://example.invalid/coastalbowl/',
    expect: { segment: 'restaurant', size: 'large', deadline: null },
    html: `<h1>Coastal Bowl</h1>
      <p>22 restaurants across Karnataka and Tamil Nadu, with a commissary in Peenya that supplies
      all of them. Over 4,000 meals served on a weekday.</p>
      <p>Purchase is centralised: one order desk, one approved supplier list.</p>`,
  },
  {
    id: 'fx07-restaurant-unknown-size',
    name: 'Green Fork',
    city: 'Bengaluru',
    url: 'https://example.invalid/greenfork/',
    expect: { segment: 'restaurant', size: 'unknown', deadline: null },
    html: `<h1>Green Fork</h1>
      <p>A restaurant in Bengaluru. Salads, bowls, and a short seasonal menu.</p>
      <p>Open daily. Reservations by phone.</p>`,
  },
  {
    id: 'fx08-hotel-large',
    name: 'The Cubbon Crest',
    city: 'Bengaluru',
    url: 'https://example.invalid/cubboncrest/',
    expect: { segment: 'hotel', size: 'large', deadline: null },
    html: `<h1>The Cubbon Crest</h1>
      <p>A 220-room business hotel with three restaurants, a banquet hall for 600 and 24-hour room
      service. Occupancy averages 78 per cent.</p>
      <p>Our kitchens take a fresh vegetable delivery every morning.</p>`,
  },
  {
    id: 'fx09-hotel-medium',
    name: 'Hotel Malnad Residency',
    city: 'Bengaluru',
    url: 'https://example.invalid/malnadresidency/',
    expect: { segment: 'hotel', size: 'medium', deadline: null },
    html: `<h1>Hotel Malnad Residency</h1>
      <p>48 rooms near Majestic, with a 60-cover vegetarian restaurant on the ground floor.</p>
      <p>Breakfast is included for all guests.</p>`,
  },
  {
    id: 'fx10-hotel-unknown-size',
    name: 'Hotel Sapphire Inn',
    city: 'Bengaluru',
    url: 'https://example.invalid/sapphireinn/',
    expect: { segment: 'hotel', size: 'unknown', deadline: null },
    html: `<h1>Hotel Sapphire Inn</h1>
      <p>Comfortable stay in Bengaluru. Air-conditioned rooms, in-house dining, airport pickup on
      request.</p>
      <p>Call the front desk to book.</p>`,
  },
  {
    id: 'fx11-caterer-large',
    name: 'Bhagya Caterers',
    city: 'Bengaluru',
    url: 'https://example.invalid/bhagyacaterers/',
    expect: { segment: 'caterer', size: 'large', deadline: null },
    html: `<h1>Bhagya Caterers</h1>
      <p>Wedding and function catering across Bengaluru for 28 years. We regularly serve 3,000 to
      5,000 plates at a single function and run four field kitchens in season.</p>
      <p>Vegetable prep starts the night before at our Vijayanagar unit.</p>`,
  },
  {
    id: 'fx12-caterer-small',
    name: 'Amma Kitchen Catering',
    city: 'Bengaluru',
    url: 'https://example.invalid/ammakitchen/',
    expect: { segment: 'caterer', size: 'small', deadline: null },
    html: `<h1>Amma Kitchen Catering</h1>
      <p>Home-style catering for small house functions, naming ceremonies and office lunches.
      Usually 40 to 80 plates. One kitchen, three of us.</p>`,
  },
  {
    id: 'fx13-caterer-medium',
    name: 'Sadhana Caterers',
    city: 'Bengaluru',
    url: 'https://example.invalid/sadhanacaterers/',
    expect: { segment: 'caterer', size: 'medium', deadline: null },
    html: `<h1>Sadhana Caterers</h1>
      <p>Office and event catering in east Bengaluru. We run two daily corporate lunch contracts of
      about 250 plates each, plus weekend functions.</p>`,
  },
  {
    id: 'fx14-retailer-small',
    name: 'Sri Ganesh Vegetable Stores',
    city: 'Bengaluru',
    url: 'https://example.invalid/sriganeshstores/',
    expect: { segment: 'retailer', size: 'small', deadline: null },
    html: `<h1>Sri Ganesh Vegetable Stores</h1>
      <p>Neighbourhood greengrocer in Jayanagar 4th Block. Fresh vegetables and greens, bought at
      the mandi every morning.</p>
      <p>One shop. Home delivery within 2 km.</p>`,
  },
  {
    id: 'fx15-retailer-large',
    name: 'DailyBasket Supermarkets',
    city: 'Bengaluru',
    url: 'https://example.invalid/dailybasket/',
    expect: { segment: 'retailer', size: 'large', deadline: null },
    html: `<h1>DailyBasket Supermarkets</h1>
      <p>60 stores across Bengaluru, Mysuru and Hubballi, with a 40,000 sq ft distribution centre at
      Nelamangala. Fresh produce is 22 per cent of our basket.</p>
      <p>Vendor registration is handled centrally by the category team.</p>`,
  },
  {
    id: 'fx16-retailer-medium',
    name: 'Corner Fresh',
    city: 'Bengaluru',
    url: 'https://example.invalid/cornerfresh/',
    expect: { segment: 'retailer', size: 'medium', deadline: null },
    html: `<h1>Corner Fresh</h1>
      <p>Four fruit and vegetable outlets in north Bengaluru, plus a small online order desk.
      About 12 staff.</p>`,
  },
  {
    id: 'fx17-manufacturer-large',
    name: 'Kaveri Frozen Foods',
    city: 'Bengaluru',
    url: 'https://example.invalid/kaverifrozen/',
    expect: { segment: 'food_manufacturer', size: 'large', deadline: null },
    html: `<h1>Kaveri Frozen Foods Pvt Ltd</h1>
      <p>IQF processing plant at Dobbaspet with a 60 tonne per day intake of fresh vegetables. We
      freeze green peas, sweet corn, mixed vegetables and cut beans for retail and food service.</p>
      <p>Cold storage: 4,500 pallet positions. FSSAI and BRCGS certified.</p>`,
  },
  {
    id: 'fx18-manufacturer-medium',
    name: 'Konkan Masala Works',
    city: 'Bengaluru',
    url: 'https://example.invalid/konkanmasala/',
    expect: { segment: 'food_manufacturer', size: 'medium', deadline: null },
    html: `<h1>Konkan Masala Works</h1>
      <p>We make curry pastes, chutneys and wet masalas at our Peenya unit. About 30 staff and a
      seasonal intake of 8 to 10 tonnes of raw vegetables and spices a week.</p>`,
  },
  {
    id: 'fx19-manufacturer-small',
    name: 'Ragi Roots Foods',
    city: 'Bengaluru',
    url: 'https://example.invalid/ragiroots/',
    expect: { segment: 'food_manufacturer', size: 'small', deadline: null },
    html: `<h1>Ragi Roots Foods</h1>
      <p>A two-person kitchen unit making ready-to-cook millet mixes and dehydrated vegetable
      powders. We batch twice a week from one rented 600 sq ft licensed kitchen.</p>`,
  },
  {
    id: 'fx20-distributor-medium',
    name: 'Vindhya Food Distributors',
    city: 'Bengaluru',
    url: 'https://example.invalid/vindhyadistributors/',
    expect: { segment: 'distributor', size: 'medium', deadline: null },
    html: `<h1>Vindhya Food Distributors</h1>
      <p>We buy from processors and deliver to hotels, restaurants and canteens in Bengaluru. Six
      refrigerated vans, one 8,000 sq ft warehouse, no retail counter.</p>`,
  },
  {
    id: 'fx21-distributor-large',
    name: 'Southline Supply Co',
    city: 'Chennai',
    url: 'https://example.invalid/southline/',
    expect: { segment: 'distributor', size: 'large', deadline: null },
    html: `<h1>Southline Supply Co</h1>
      <p>HoReCa distribution across four southern states. 40 vehicles, 9 depots, 1,800 active
      customer outlets. We stock dry goods, dairy, frozen and fresh produce.</p>`,
  },
  {
    id: 'fx22-institution-tender-hostel',
    name: 'Karnataka Residential Hostel Society',
    city: 'Bengaluru',
    url: 'https://example.invalid/tenders/hostel-mess',
    expect: { segment: 'institution', size: 'large', deadline: '2026-09-24' },
    html: `<h1>Tender notice: supply of fresh vegetables to hostel messes</h1>
      <p>Sealed tenders are invited for the supply of fresh vegetables to 14 residential hostels
      feeding approximately 4,200 students daily for the year 2026-27.</p>
      <p>Estimated quantity: 1,500 kg per day. Last date for submission of bids: 24-09-2026, 3 p.m.
      Bid opening: 25-09-2026.</p>`,
  },
  {
    id: 'fx23-institution-tender-hospital',
    name: 'District Hospital Diet Section',
    city: 'Bengaluru',
    url: 'https://example.invalid/tenders/hospital-diet',
    expect: { segment: 'institution', size: 'large', deadline: '2026-10-02' },
    html: `<h1>Supply of vegetables and provisions - patient diet</h1>
      <p>The District Hospital invites rate contracts for the supply of vegetables, fruits and
      provisions for patient diet, 750 beds, for twelve months.</p>
      <p>Bids close on 02-10-2026. EMD as per the tender document. Only firms with two years of
      similar supply experience may apply.</p>`,
  },
  {
    id: 'fx24-institution-tender-school',
    name: 'Vidya Vikas School Trust',
    city: 'Bengaluru',
    url: 'https://example.invalid/tenders/school-canteen',
    expect: { segment: 'institution', size: 'medium', deadline: '2026-09-30' },
    html: `<h1>Canteen vegetable supply - request for quotation</h1>
      <p>Quotations are invited for supplying fresh vegetables to our school canteen, serving about
      600 mid-day meals on working days.</p>
      <p>Quotations must reach the trust office by 30-09-2026.</p>`,
  },
  {
    id: 'fx25-institution-no-deadline',
    name: 'Sarkari Bhavan Staff Canteen',
    city: 'Bengaluru',
    url: 'https://example.invalid/news/staff-canteen-reopens',
    expect: { segment: 'institution', size: 'medium', deadline: null },
    html: `<h1>Staff canteen reopens after renovation</h1>
      <p>The staff canteen at Sarkari Bhavan has reopened after a four-month renovation. It serves
      about 500 employees at lunch and will now run a separate salad counter.</p>
      <p>The canteen contractor said vegetable purchase would move to daily deliveries.</p>`,
  },
  {
    id: 'fx26-not-a-business-error',
    name: 'Unknown',
    city: null,
    url: 'https://example.invalid/oops',
    expect: { segment: 'other', size: 'unknown', deadline: null },
    html: `<h1>404 - Page not found</h1>
      <p>The page you asked for is not here. It may have been moved or deleted.</p>
      <p><a href="/">Return to the home page</a></p>`,
  },
  {
    id: 'fx27-not-a-business-nav',
    name: 'Unknown',
    city: null,
    url: 'https://example.invalid/cookies',
    expect: { segment: 'other', size: 'unknown', deadline: null },
    html: `<h1>Cookie preferences</h1>
      <p>We use cookies to improve your experience. Choose which categories you allow.</p>
      <ul><li>Strictly necessary</li><li>Analytics</li><li>Advertising</li></ul>
      <p>Home | About | Contact | Privacy</p>`,
  },
  {
    id: 'fx28-blog-about-prices',
    name: 'Mandi Watch',
    city: 'Bengaluru',
    url: 'https://example.invalid/blog/tomato-prices',
    expect: { segment: 'other', size: 'unknown', deadline: null },
    html: `<h1>Why tomato prices swing every August</h1>
      <p>A look at the rain, the transport cost and the two-week gap between crops that sends
      tomato rates up and down every year. Written by a reader who follows the mandi.</p>
      <p>This blog does not buy or sell anything.</p>`,
  },
  {
    id: 'fx29-news-restaurant-opening',
    name: 'Bhojan Ghar',
    city: 'Bengaluru',
    url: 'https://example.invalid/news/bhojan-ghar-opening',
    expect: { segment: 'restaurant', size: 'medium', deadline: '2026-09-19' },
    html: `<h1>Bhojan Ghar to open second outlet in Whitefield</h1>
      <p>Bhojan Ghar, which runs a 90-cover restaurant in Koramangala, will open its second outlet
      in Whitefield on 19-09-2026. The new kitchen will seat 140.</p>
      <p>The owners said they are still finalising vegetable suppliers for the new kitchen.</p>`,
  },
  {
    id: 'fx30-news-hotel-opening',
    name: 'Grand Deccan',
    city: 'Hyderabad',
    url: 'https://example.invalid/news/grand-deccan-opens',
    expect: { segment: 'hotel', size: 'large', deadline: '2026-10-01' },
    html: `<h1>Grand Deccan to open 180-room hotel on 01-10-2026</h1>
      <p>The Grand Deccan group will open a 180-room property in Hyderabad on 01-10-2026, with two
      restaurants, a banquet hall for 400 and an all-day cafe.</p>
      <p>The group said purchase contracts for fresh produce are being awarded this month.</p>`,
  },
];

export default CASES;
