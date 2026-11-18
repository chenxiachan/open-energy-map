// Typical level of measured consumption for a calculated demand (Loga et al. 2019, BBSR-Online-Publikation 04/2019;
// published as Loga & Stein 2022, eceee Summer Study, paper 4-034-22, formula annex).
//
// The function maps the energy demand of the German standard EPC calculation (DIN V 4108-6 + 4701-10) for heating and
// hot water, per m² heated living space and year, fuels on the gross calorific value (Hs), to the expected metered
// consumption. Basis: 2,857 residential buildings with fuels or district heating from 6 German studies, consumption
// normalised to the standard climate. Single buildings scatter around it with a multiplicative standard deviation of
// 1.48 (×0.68 to ×1.48 for one standard deviation). Heat pumps and direct electric heating are not in the sample.
//
// "Model 2" of the paper, the one the authors propose for the German EPC procedure (R syntax in the annex):
//   q ≤ 66:  0.5 · (−0.2 + 1.3 / (1 + 0.5 q / 550) + 1) · q
//   q > 66:  33 + max(0.4, −0.2 + 1.3 / (1 + (q − 33) / 550)) · (q − 33)
// For the newer DIN V 18599 procedure the paper estimates the old demand as 0.86 × the new one for boilers (0.71 for heat
// pumps); oldMethodFactor applies that conversion first (a sensitivity here, since this model is neither procedure).
export const TYPICAL_SD = 1.48;
export const TYPICAL_REF = 'Loga et al. 2019 (BBSR-Online 04/2019); Loga & Stein 2022, eceee Summer Study 4-034-22, Model 2';
export function typicalConsumption(q) {
  if (!(q > 0)) return 0;
  if (q <= 66) return 0.5 * (-0.2 + 1.3 / (1 + (0.5 * q) / 550) + 1) * q;
  return 33 + Math.max(0.4, -0.2 + 1.3 / (1 + (q - 33) / 550)) * (q - 33);
}
// expected consumption for a demand q (same unit), optionally converted from the DIN V 18599 procedure first
export function typicalOf(q, { oldMethodFactor = 1 } = {}) {
  const c = typicalConsumption(q * oldMethodFactor);
  return { q, c, f: q > 0 ? c / q : 1, lo: c / TYPICAL_SD, hi: c * TYPICAL_SD };
}
// systems the function covers: fuels and district heating (central boilers, district heat), not heat pumps or electric
export const typicalCovers = (system) => !/heat_pump|hp|electric|strom/i.test(String(system || ''));
