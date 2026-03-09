import { describe, expect, it } from 'vitest'
import { zipSync, strToU8 } from 'fflate'

import { importCampaignZip } from './zip-campaign'

describe('zip-campaign security', () => {
  it('拒绝路径穿越文件名', async () => {
    const zip = zipSync({
      '../evil.txt': strToU8('x'),
      'campaign/manifest.json': strToU8(JSON.stringify({ id: '1', name: 'n', version: '0.1.0', schemaVersion: 1 })),
      'campaign/map.json': strToU8(JSON.stringify({ width: 1, height: 1, cells: [[{ x: 0, y: 0, terrain: 'plain', fogLevel: 3 }]] })),
      'campaign/factions.json': strToU8(JSON.stringify([])),
      'campaign/units.json': strToU8(JSON.stringify([])),
      'campaign/commanders.json': strToU8(JSON.stringify([])),
      'campaign/rules.json': strToU8(JSON.stringify({})),
      'campaign/victory.json': strToU8(JSON.stringify({})),
    })

    await expect(importCampaignZip('save_not_exists', zip)).rejects.toThrow('路径穿越')
  })
})
