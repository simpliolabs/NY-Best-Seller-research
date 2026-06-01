import { config } from 'dotenv';
config();

const key = process.env.ETSY_API_KEY;
const secret = process.env.ETSY_API_SECRET;
console.log('Key len:', key?.length, 'Secret len:', secret?.length);

const url = 'https://openapi.etsy.com/v3/application/listings/active?keywords=pickleball+shirt&limit=3&sort_on=score';

// Try 1: key:secret combined
const combined = `${key}:${secret}`;
const res1 = await fetch(url, { headers: { 'x-api-key': combined } });
console.log('Status (key:secret):', res1.status);
const d1 = await res1.json();
if (d1.results) {
  d1.results.forEach(l => console.log('  Listing:', l.listing_id, '|', l.title));
} else {
  console.log(' ', JSON.stringify(d1).slice(0, 200));
}
