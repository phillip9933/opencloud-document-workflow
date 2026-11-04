// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve, posix } from 'node:path'
import { pathToFileURL } from 'node:url'
function scalar(value, label) {
  if (typeof value !== 'string' || !value || /[\r\n\x00]/.test(value))
    throw Error('Invalid ' + label)
  return value
}
export function installationPlan({
  origin,
  image,
  mounts,
  networks,
  proxyNetworks,
  apps,
  network,
  entrypoint,
  version,
  ollama,
  trustedCA,
  proxyMode,
  previous
}) {
  const url = new URL(scalar(origin, 'OpenCloud origin'))
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    !/^[a-z0-9.-]+$/i.test(url.hostname)
  )
    throw Error('Use the existing HTTPS OpenCloud origin without a path')
  if (
    !/^(?:[a-zA-Z0-9][a-zA-Z0-9./:_-]*(?:@sha256:[a-f0-9]{64})?|sha256:[a-f0-9]{64})$/.test(
      scalar(image, 'image')
    )
  )
    throw Error('Invalid image reference')
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw Error('Invalid release version')
  const project =
    'document-workflow-' + createHash('sha256').update(url.origin).digest('hex').slice(0, 10)
  if (previous) {
    if (previous.name !== project)
      throw Error('Previous deployment belongs to another OpenCloud origin')
    const old = previous.services?.companion
    if (!old) throw Error('Previous deployment has no companion')
    if (ollama === undefined) ollama = old.environment?.WORKFLOW_OLLAMA_URL
    if (trustedCA === undefined) {
      const mount = old.volumes?.find(
        (v) => typeof v === 'object' && v.target === '/etc/workflow-extra-ca.pem'
      )
      if (mount) trustedCA = mount.source.replaceAll('$$', '$')
    }
    if (proxyMode === undefined)
      proxyMode = old.labels?.['traefik.enable'] === 'false' ? 'external' : 'traefik'
    if (entrypoint === undefined)
      entrypoint = old.labels?.[`traefik.http.routers.${project}.entrypoints`]
  }
  entrypoint ??= 'https'
  proxyMode ??= 'traefik'
  if (!/^[a-zA-Z0-9_.-]+$/.test(entrypoint))
    throw Error('Choose one existing HTTPS proxy entrypoint')
  if (!['traefik', 'external'].includes(proxyMode))
    throw Error('Choose traefik or external proxy mode')
  const webPath = '/var/lib/opencloud/web/assets/apps'
  if (!apps) {
    const candidates = mounts
      .filter(
        (m) =>
          ['bind', 'volume'].includes(m.Type) &&
          m.Source?.startsWith('/') &&
          (m.Destination === webPath || webPath.startsWith(m.Destination + '/'))
      )
      .sort((a, b) => b.Destination.length - a.Destination.length)
    if (!candidates.length) throw Error('Could not discover the apps directory; pass --apps-dir')
    const m = candidates[0]
    apps = posix.join(m.Source, posix.relative(m.Destination, webPath))
  }
  scalar(apps, 'apps directory')
  if (!apps.startsWith('/') || apps.includes('/../') || apps === '/')
    throw Error('Use an absolute apps directory')
  const shared = networks.filter((n) => proxyNetworks.includes(n))
  if (!network) {
    if (shared.length !== 1) throw Error('Choose the proxy network with --network')
    network = shared[0]
  }
  if (
    !/^[a-zA-Z0-9_.-]+$/.test(network) ||
    !networks.includes(network) ||
    !proxyNetworks.includes(network)
  )
    throw Error('Network must already connect OpenCloud and the proxy')
  origin = url.origin
  const security = { read_only: true, cap_drop: ['ALL'], security_opt: ['no-new-privileges:true'] }
  // The lock helper creates history before Compose; declare that volume external
  // so Compose neither warns about ownership nor removes recovery records.
  const volumes = {
    state: {},
    credentials: {},
    backups: {},
    ocr: {},
    history: { external: true, name: project + '_history' }
  }
  const plan = {
    name: project,
    services: {
      companion: {
        image,
        ...security,
        user: '65534:65534',
        restart: 'unless-stopped',
        pids_limit: 96,
        mem_limit: '2g',
        cpus: 2,
        stop_grace_period: '180s',
        tmpfs: ['/tmp:rw,noexec,nosuid,size=256m'],
        volumes: [
          'state:/state',
          'credentials:/credentials',
          'backups:/backups',
          'ocr:/workflow-tessdata'
        ],
        environment: {
          WORKFLOW_APP_ORIGIN: origin,
          WORKFLOW_OPENCLOUD_ORIGIN: origin,
          WORKFLOW_CONVERSION_URL: 'http://converter:5180'
        },
        networks: ['opencloud', 'conversion'],
        labels: {
          'traefik.enable': 'true',
          'traefik.docker.network': network,
          [`traefik.http.routers.${project}.rule`]: `Host(\`${url.hostname}\`) && PathPrefix(\`/_workflow/api/\`)`,
          [`traefik.http.routers.${project}.entrypoints`]: entrypoint,
          [`traefik.http.routers.${project}.tls`]: 'true',
          [`traefik.http.routers.${project}.priority`]: '200',
          [`traefik.http.routers.${project}.service`]: project,
          [`traefik.http.services.${project}.loadbalancer.server.port`]: '5175'
        }
      },
      converter: {
        image,
        ...security,
        user: '65534:65534',
        restart: 'unless-stopped',
        pids_limit: 96,
        mem_limit: '2g',
        cpus: 2,
        tmpfs: ['/tmp:rw,noexec,nosuid,size=768m'],
        networks: ['conversion'],
        command: ['companion/conversion-server.mjs'],
        environment: { WORKFLOW_MODE: 'converter' },
        labels: { 'traefik.enable': 'false' },
        healthcheck: {
          test: [
            'CMD',
            'node',
            '-e',
            "fetch('http://127.0.0.1:5180/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
          ],
          interval: '30s',
          timeout: '5s',
          retries: 3
        }
      },
      'web-assets': {
        image,
        ...security,
        user: '0:0',
        cap_add: ['DAC_OVERRIDE', 'CHOWN'],
        network_mode: 'none',
        profiles: ['install'],
        entrypoint: ['node', '/distribution/web-assets.mjs'],
        command: ['check'],
        volumes: [
          { type: 'bind', source: apps, target: '/web-apps', bind: { create_host_path: false } },
          'history:/install-history'
        ]
      },
      checkpoint: {
        image,
        ...security,
        user: '65534:65534',
        network_mode: 'none',
        profiles: ['install'],
        entrypoint: ['node', '/distribution/checkpoint.mjs'],
        volumes: ['state:/state:ro', 'backups:/backups']
      }
    },
    networks: { opencloud: { external: true, name: network }, conversion: { internal: true } },
    volumes
  }
  if (proxyMode === 'external') plan.services.companion.labels = { 'traefik.enable': 'false' }
  if (ollama) {
    const endpoint = new URL(ollama)
    if (
      !['http:', 'https:'].includes(endpoint.protocol) ||
      endpoint.username ||
      endpoint.password ||
      endpoint.origin !== ollama
    )
      throw Error('Use an Ollama origin without credentials or a path')
    plan.services.companion.environment.WORKFLOW_OLLAMA_URL = ollama
  }
  if (trustedCA) {
    scalar(trustedCA, 'trusted CA file')
    if (!trustedCA.startsWith('/') || trustedCA === '/')
      throw Error('Use an absolute existing CA file')
    plan.services.companion.volumes.push({
      type: 'bind',
      source: trustedCA,
      target: '/etc/workflow-extra-ca.pem',
      read_only: true,
      bind: { create_host_path: false }
    })
    plan.services.companion.environment.NODE_EXTRA_CA_CERTS = '/etc/workflow-extra-ca.pem'
  }
  // Compose interpolates dollar signs even inside JSON string values.
  return JSON.parse(JSON.stringify(plan).replaceAll('$', () => '$$'))
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const e = process.env,
      release = JSON.parse(await readFile('/distribution/release.json', 'utf8'))
    let prior = ''
    for await (const part of process.stdin) {
      prior += part
      if (prior.length > 65536) throw Error('Prior plan too large')
    }
    const plan = installationPlan({
      origin: e.INSTALL_ORIGIN,
      image: e.INSTALL_IMAGE,
      mounts: JSON.parse(e.INSTALL_MOUNTS),
      networks: Object.keys(JSON.parse(e.INSTALL_NETWORKS)),
      proxyNetworks: Object.keys(JSON.parse(e.INSTALL_PROXY_NETWORKS)),
      apps: e.INSTALL_APPS || undefined,
      network: e.INSTALL_NETWORK || undefined,
      entrypoint: e.INSTALL_ENTRYPOINT || undefined,
      version: release.version,
      ollama: e.INSTALL_OLLAMA === 'off' ? null : e.INSTALL_OLLAMA || undefined,
      trustedCA: e.INSTALL_CA === 'off' ? null : e.INSTALL_CA || undefined,
      proxyMode: e.INSTALL_PROXY_MODE || undefined,
      previous: prior.trim() ? JSON.parse(prior) : undefined
    })
    if (plan.services.companion.environment.WORKFLOW_OLLAMA_URL)
      (await import('/app/companion/ollama.mjs')).localEndpoint(
        plan.services.companion.environment.WORKFLOW_OLLAMA_URL
      )
    console.log(JSON.stringify(plan, null, 2))
  } catch (e) {
    console.error(e.message)
    process.exitCode = 1
  }
}
