import { OVR_WEIGHTS, PlayerCard, Ratings } from '../data/players';
import { esc } from './dom';

const RATING_LABELS: Record<keyof Ratings, string> = {
  spd: 'SPD', str: 'STR', agi: 'AGI', cth: 'CTH', car: 'CAR', thp: 'THP', tha: 'THA',
  blk: 'BLK', tak: 'TAK', cov: 'COV', prs: 'PRS', kpw: 'KPW', kac: 'KAC',
};

export function keyRatings(card: PlayerCard): [string, number][] {
  return (Object.keys(OVR_WEIGHTS[card.pos]) as (keyof Ratings)[]).map((k) => [RATING_LABELS[k], card.ratings[k]]);
}

/** A collectible player card in the 2015 mobile style: tier frame, big OVR, position, name. */
export function cardHtml(card: PlayerCard, opts: { small?: boolean; badge?: string; id?: boolean } = {}): string {
  const stats = keyRatings(card)
    .slice(0, 3)
    .map(([k, v]) => `<span><b>${v}</b> ${k}</span>`)
    .join('');
  return `
  <div class="card tier-${card.tier}${opts.small ? ' small' : ''}" ${opts.id ? `data-card="${esc(card.id)}"` : ''}>
    ${opts.badge ? `<div class="card-badge">${esc(opts.badge)}</div>` : ''}
    <div class="card-top"><div class="card-ovr">${card.ovr}</div><div class="card-pos">${card.pos}</div></div>
    <div class="card-silhouette"><div class="card-num">${card.number}</div></div>
    <div class="card-name">${esc(card.first)}<br><b>${esc(card.last)}</b></div>
    ${opts.small ? '' : `<div class="card-stats">${stats}</div>`}
    <div class="card-team">${esc(card.team)}</div>
  </div>`;
}

export function ratingsTable(card: PlayerCard): string {
  const keys = Object.keys(OVR_WEIGHTS[card.pos]) as (keyof Ratings)[];
  const rest = (Object.keys(RATING_LABELS) as (keyof Ratings)[]).filter((k) => !keys.includes(k));
  const row = (k: keyof Ratings, key: boolean) =>
    `<div class="rating-row${key ? ' key' : ''}"><span>${RATING_LABELS[k]}</span><div class="bar"><i style="width:${card.ratings[k]}%"></i></div><b>${card.ratings[k]}</b></div>`;
  return `<div class="ratings">${keys.map((k) => row(k, true)).join('')}${rest.map((k) => row(k, false)).join('')}</div>`;
}
