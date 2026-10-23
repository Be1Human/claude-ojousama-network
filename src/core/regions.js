export const warningRegions = Object.freeze({ CN: '中国', HK: '中国香港' });
const codes = new Set(('AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS XK YE YT ZA ZM ZW').split(' '));
const names = new Map();
const normalize = value => String(value || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
const chinese = new Intl.DisplayNames(['zh-CN'], { type: 'region' });
for (const locale of ['en', 'zh-CN']) {
  const display = new Intl.DisplayNames([locale], { type: 'region' });
  for (const code of codes) names.set(normalize(display.of(code)), code);
}
for (const name of ['China', 'People\'s Republic of China', 'People’s Republic of China', '中国', '中华人民共和国', '中国大陆', '中国内地']) names.set(normalize(name), 'CN');
for (const name of ['Hong Kong', 'Hong Kong SAR', 'Hong Kong SAR China', 'Hong Kong SAR, China', 'Hong Kong S.A.R., China', 'Hong Kong, China', '香港', '中国香港', '香港特别行政区', '中国香港特别行政区', '中华人民共和国香港特别行政区']) names.set(normalize(name), 'HK');

export function countryCode(geo) {
  if (!geo || typeof geo !== 'object') return '';
  const code = String(geo.countryCode || geo.country_code || '').trim().toUpperCase();
  if (code) return codes.has(code) ? code : '';
  const name = normalize(geo.country);
  return codes.has(name.toUpperCase()) ? name.toUpperCase() : names.get(name) || '';
}
export function excludedRegion(geo) {
  const code = countryCode(geo);
  return Object.hasOwn(warningRegions, code) ? code : '';
}
export function countryName(code) { return codes.has(code) ? warningRegions[code] || chinese.of(code) || code : '归属地未确认'; }
export function confirmedNonChina(geo) { return !!countryCode(geo) && !excludedRegion(geo); }
