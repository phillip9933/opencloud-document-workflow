// SPDX-License-Identifier: AGPL-3.0-only
import { mount } from '@vue/test-utils'
import MetadataFieldDefinition from '../../src/components/MetadataFieldDefinition.vue'
import MetadataTagDefinition from '../../src/components/MetadataTagDefinition.vue'
import type { FieldDefinition, TagRule } from '../../src/domain/metadata'
it('field definition edits emit patches without changing saved values or usage', async () => {
  const field: FieldDefinition = {
    id: 'category',
    label: 'Category',
    type: 'choice',
    aliases: ['Category'],
    choices: ['One', 'Two']
  }
  Object.freeze(field)
  Object.freeze(field.aliases)
  Object.freeze(field.choices)
  const w = mount(MetadataFieldDefinition, {
    props: { field, open: true, usageLabel: 'Used by 3 documents', usageCount: 3 }
  })
  try {
    const inputs = w.findAll('input')
    await inputs[1]!.setValue('New label')
    await inputs[3]!.setValue('Three, Four')
    expect(w.emitted('update')).toEqual([
      [{ label: 'New label' }],
      [{ choices: ['Three', 'Four'] }]
    ])
    expect(field.label).toBe('Category')
    expect(field.choices).toEqual(['One', 'Two'])
    expect(w.get('.usage-count').attributes('aria-label')).toBe('Used by 3 documents')
    await w.get('[aria-label="Remove field"]').trigger('click')
    expect(w.emitted('remove')).toHaveLength(1)
    expect(w.find('dialog').exists()).toBe(false)
  } finally {
    w.unmount()
  }
})
it('tag definition toggling and alias edits remain parent-controlled', async () => {
  const rule: TagRule = Object.freeze({ tag: 'Person', terms: ['Alex'], match: 'name' })
  const w = mount(MetadataTagDefinition, {
    props: { rule, open: false, usageLabel: 'Counts unavailable', usageCount: '—' }
  })
  try {
    await w.get('summary').trigger('click')
    expect(w.emitted('toggle')).toHaveLength(1)
    expect(w.get('details').attributes('open')).toBeUndefined()
    await w.setProps({ open: true })
    await w.get('select').setValue('substring')
    await w.findAll('input')[1]!.setValue('Alex, アレックス')
    expect(w.emitted('update')).toEqual([
      [{ match: undefined }],
      [{ terms: ['Alex', 'アレックス'] }]
    ])
    expect(rule.match).toBe('name')
    expect(rule.terms).toEqual(['Alex'])
    await w.get('[aria-label="Remove tag"]').trigger('click')
    expect(w.emitted('remove')).toHaveLength(1)
  } finally {
    w.unmount()
  }
})
