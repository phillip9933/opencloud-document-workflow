// SPDX-License-Identifier: AGPL-3.0-only
import {computed,inject,onBeforeUnmount,onMounted,provide,ref} from 'vue'
import type {InjectionKey} from 'vue'
export type ThemePreference='system'|'light'|'dark'
const key='document-workflow:appearance'
function valid(value:unknown):value is ThemePreference{return value==='system'||value==='light'||value==='dark'}
export function createTheme(storage:Pick<Storage,'getItem'|'setItem'>|undefined,media:MediaQueryList|null){
 let initial:ThemePreference='system';try{const saved=storage?.getItem(key);if(valid(saved))initial=saved}catch{/* A blocked device preference must not block document work. */}
 const preference=ref<ThemePreference>(initial),systemDark=ref(media?.matches??false)
 const effective=computed<'light'|'dark'>(()=>preference.value==='system'?(systemDark.value?'dark':'light'):preference.value)
 function set(value:string){if(!valid(value))return;preference.value=value;try{storage?.setItem(key,value)}catch{/* Keep the selection for this session. */}}
 const changed=(event:MediaQueryListEvent)=>{systemDark.value=event.matches}
 function start(){media?.addEventListener?.('change',changed)}
 function stop(){media?.removeEventListener?.('change',changed)}
 return{preference,effective,set,start,stop}
}
export type Theme=ReturnType<typeof createTheme>
export const themeKey:InjectionKey<Theme>=Symbol('Document Workflow appearance')
export function provideTheme(){let storage:Storage|undefined;try{storage=globalThis.localStorage}catch{}const theme=createTheme(storage,typeof globalThis.matchMedia==='function'?globalThis.matchMedia('(prefers-color-scheme: dark)'):null);provide(themeKey,theme);onMounted(theme.start);onBeforeUnmount(theme.stop);return theme}
export function useTheme(){return inject(themeKey)??createTheme(undefined,null)}
