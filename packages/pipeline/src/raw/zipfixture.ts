import { crc32, deflateRawSync } from 'node:zlib';

/** A small zip archive (deflated entries, no extras) for tests: entry name → text or bytes. */
export function makeZip(entries: Record<string, string | Uint8Array>): Uint8Array {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const data = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content);
    const packed = deflateRawSync(data);
    const fileName = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4); // version needed
    head.writeUInt16LE(0x0800, 6); // UTF-8 names
    head.writeUInt16LE(8, 8); // deflate
    head.writeUInt16LE(0, 10); // time
    head.writeUInt16LE(0x21, 12); // date: 1980-01-01
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(packed.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(fileName.length, 26);
    head.writeUInt16LE(0, 28);
    local.push(head, fileName, packed);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4); // made by
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(8, 10);
    dir.writeUInt16LE(0, 12);
    dir.writeUInt16LE(0x21, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(packed.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(fileName.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, fileName);
    offset += head.length + fileName.length + packed.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  const count = Object.keys(entries).length;
  end.writeUInt16LE(count, 8);
  end.writeUInt16LE(count, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...local, cd, end]));
}

/** A tiny GTFS feed (the six tables gtfs.ts reads) valid 20261101–20270131: line 13 runs one trip daily, another on weekdays only. */
export const GTFS_FIXTURE: Record<string, string> = {
  'routes.txt': 'route_id,route_short_name\nde:vrs:13:104,13\nde:vrs:999:1,999\n',
  'trips.txt': 'route_id,service_id,trip_id,trip_headsign\nde:vrs:13:104,daily,t1,Sülzgürtel\nde:vrs:13:104,weekdays,t2,Holweide\nde:vrs:999:1,daily,t3,Elsewhere\n',
  'calendar.txt':
    '﻿service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n' +
    'daily,1,1,1,1,1,1,1,20261101,20270131\nweekdays,1,1,1,1,1,0,0,20261101,20270131\n',
  'calendar_dates.txt': 'service_id,date,exception_type\ndaily,20261129,2\n',
  'stops.txt': 'stop_id,stop_name,stop_lat,stop_lon\ns1,"Neusser Str., Gürtel",50.9600,6.9500\ns2,Lohsestr.,50.9620,6.9510\n',
  'stop_times.txt':
    'trip_id,arrival_time,departure_time,stop_id,stop_sequence\n' +
    't1,08:00:00,08:00:30,s1,1\nt1,08:02:00,08:02:00,s2,2\nt2,09:02:00,09:02:00,s2,2\nt2,09:00:00,09:00:00,s1,1\nt3,10:00:00,10:00:00,s1,1\nt3,10:05:00,10:05:00,s2,2\n',
};
