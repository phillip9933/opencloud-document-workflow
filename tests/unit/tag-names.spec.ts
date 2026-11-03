// SPDX-License-Identifier: AGPL-3.0-only
import {existingTagName} from '../../src/domain/tag-names'
it('ignores capitalization, keeps native spelling and refuses ambiguous case variants without merging them',()=>{expect(existingTagName('vEHiCLES',['Vehicles'])).toBe('Vehicles');expect(existingTagName('Vehicles',['Vehicles','vehicles'])).toBe('Vehicles');expect(()=>existingTagName('VEHICLES',['Vehicles','vehicles'])).toThrow('exact tag');expect(existingTagName('new',['Vehicles'])).toBe('new');expect(existingTagName('電気',['電気'])).toBe('電気')})
