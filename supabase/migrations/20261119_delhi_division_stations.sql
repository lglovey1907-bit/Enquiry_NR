-- Extra lock: no user role may touch station keys directly (security-definer functions still work).
alter table private.station_keys enable row level security;
revoke all on private.station_keys from anon, authenticated;

-- Delhi Division stations, same defaults and local-station hide list as ANVT. Additive only.
insert into public.stations (code, name_en, name_hi, zone_division, local_codes, active)
select v.code, v.name_en, v.name_hi, a.zone_division, a.local_codes, true
from (values ('DLI','Delhi Junction','दिल्ली जं.'),
             ('NZM','Hazrat Nizamuddin','हज़रत निज़ामुद्दीन जं.'),
             ('DEE','Delhi Sarai Rohilla','दिल्ली सराय रोहिल्ला'),
             ('GZB','Ghaziabad','गाज़ियाबाद'),
             ('GGN','Gurgaon','गुड़गांव')) v(code, name_en, name_hi)
cross join (select zone_division, local_codes from public.stations where code = 'ANVT') a
on conflict (code) do nothing;
