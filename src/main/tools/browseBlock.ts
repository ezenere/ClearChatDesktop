// browse_url: requisições que a janela oculta NÃO faz (função pura — e2e/browsePage.test.ts). Sites
// de notícia/receita (UOL, Tudo Gostoso…) disparam centenas de requisições de anúncio e rastreamento
// (800+ para 240 domínios numa página medida em 2026-11-15) que seguram o evento de load por muito
// mais que o timeout — e nada disso é conteúdo. A página principal nunca é bloqueada (o usuário pode
// pedir para abrir o próprio domínio).

/** Domínios de anúncio/rastreamento/consentimento (o domínio e os subdomínios). */
const AD_HOSTS = [
  'doubleclick.net',
  'googlesyndication.com',
  'googletagservices.com',
  'googletagmanager.com',
  'google-analytics.com',
  'googleadservices.com',
  'fundingchoicesmessages.google.com',
  'adservice.google.com',
  'pubmatic.com',
  'rubiconproject.com',
  'amazon-adsystem.com',
  'taboola.com',
  'outbrain.com',
  'criteo.com',
  'criteo.net',
  'seedtag.com',
  'smilewanted.com',
  'sharethrough.com',
  'adnxs.com',
  'openx.net',
  'casalemedia.com',
  'indexww.com',
  'teads.tv',
  'smartadserver.com',
  'scorecardresearch.com',
  'hotjar.com',
  'chartbeat.com',
  'chartbeat.net',
  'quantserve.com',
  'moatads.com',
  'adsrvr.org',
  '3lift.com',
  'bidswitch.net',
  'mgid.com',
  'media.net',
  'lijit.com',
  'sovrn.com',
  'demdex.net',
  'krxd.net',
  'id5-sync.com',
  'crwdcntrl.net',
  'adform.net',
  'yieldmo.com',
  'onetag-sys.com',
  'sonobi.com',
  'everesttech.net',
  'tapad.com',
  'rlcdn.com',
  'bluekai.com',
  'adsafeprotected.com',
  'doubleverify.com',
  '33across.com',
  'connatix.com',
  'primis.tech',
  'unrulymedia.com',
  'spotxchange.com',
  'springserve.com'
]

/** Tipos que nunca servem ao texto da página (imagens já vão desligadas na janela). */
const SKIP_TYPES = new Set(['image', 'media', 'font', 'ping'])

const isAdHost = (host: string): boolean =>
  AD_HOSTS.some((d) => host === d || host.endsWith(`.${d}`)) ||
  /(^|\.)adservice\.google\.[a-z.]+$/.test(host)

/** A janela do browse_url pula esta requisição? (`resourceType` do `webRequest` do Electron.) */
export function isBlockedBrowseRequest(url: string, resourceType: string): boolean {
  if (resourceType === 'mainFrame') return false
  if (SKIP_TYPES.has(resourceType)) return true
  const host = hostOf(url)
  return !!host && isAdHost(host)
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}
