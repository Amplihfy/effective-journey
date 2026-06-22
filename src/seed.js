// Populate the database with a sample session and records for a quick demo.
import { createSession, addRecord, stats } from './db.js';

const session = createSession({
  name: 'Demo survey — Oak Hill',
  operator: 'Sample Operator',
  device: 'desktop',
});

const samples = [
  { deceased_name: 'Eleanor M. Whitfield', section: 'A', plot: '12',
    birth_date: '1888-03-04', death_date: '1962-11-20',
    latitude: 38.88930, longitude: -77.00640,
    notes: 'Granite headstone. Inscription: "Beloved mother." Good condition.' },
  { deceased_name: 'Thomas A. Whitfield', section: 'A', plot: '13',
    birth_date: '1884-07-19', death_date: '1957-02-02',
    latitude: 38.88934, longitude: -77.00631,
    notes: 'Shared family marker with Eleanor.' },
  { deceased_name: 'Capt. James Holloway', section: 'B', plot: '04',
    birth_date: '1842-01-10', death_date: '1901-09-30',
    latitude: 38.88951, longitude: -77.00672,
    notes: 'Civil War veteran. Bronze plaque, light corrosion.' },
  { deceased_name: 'Mary O’Connor', section: 'C', plot: '27',
    birth_date: '1910-05-22', death_date: '1994-12-15',
    latitude: 38.88912, longitude: -77.00701,
    notes: 'Celtic cross, weathered. Faint inscription.' },
  { deceased_name: 'Infant Doe', section: 'C', plot: '28',
    notes: 'Small unmarked footstone, no legible name. Recorded as unknown.' },
];

for (const r of samples) addRecord(session.id, r);

console.log('Seeded sample data:', stats());
