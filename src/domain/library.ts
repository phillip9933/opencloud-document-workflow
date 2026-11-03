// SPDX-License-Identifier: AGPL-3.0-only
export interface LibraryEntry {path:string;resourceId:string;etag?:string;folder:boolean;tags:string[];fields?:Record<string,string|number>}
export interface LibraryFilter {search:string;tags:string[];format:string}
export const libraryFormats=['PDF','Images','Spreadsheets','Text documents','Presentations','Other'] as const
const fold=(value:string)=>value.normalize('NFKC').toLowerCase()
export function libraryFormat(path:string):string{const extension=path.split('.').pop()?.toLowerCase()??'';return extension==='pdf'?'PDF':/^(png|jpe?g|gif|webp|tiff?|bmp|heic|avif)$/.test(extension)?'Images':/^(xlsx?|ods|csv|tsv)$/.test(extension)?'Spreadsheets':/^(docx?|odt|rtf|txt|md)$/.test(extension)?'Text documents':/^(pptx?|odp)$/.test(extension)?'Presentations':'Other'}
export function filterLibrary(entries:LibraryEntry[],filter:LibraryFilter){const terms=fold(filter.search).split(/\s+/u).filter(Boolean);return entries.filter(entry=>!entry.folder&&(!filter.format||libraryFormat(entry.path)===filter.format)&&filter.tags.every(tag=>entry.tags.includes(tag))&&terms.every(term=>fold([entry.path,...entry.tags,...Object.values(entry.fields??{}).map(String)].join(' ')).includes(term)))}
export function libraryFacets(entries:LibraryEntry[],filter:LibraryFilter){const counts=new Map<string,number>();for(const entry of filterLibrary(entries,filter))for(const tag of new Set(entry.tags))counts.set(tag,(counts.get(tag)??0)+1);for(const tag of filter.tags)if(!counts.has(tag))counts.set(tag,0);return[...counts].map(([tag,count])=>({tag,count})).sort((a,b)=>a.tag.localeCompare(b.tag,undefined,{numeric:true,sensitivity:'base'}))}
export function libraryAncestors(path:string,root:string){const parents:string[]=[];let parent=path.split('/').slice(0,-1).join('/');while(parent&&parent!==root&&parent.startsWith(root+'/')){parents.unshift(parent);parent=parent.split('/').slice(0,-1).join('/')}return parents}
export function libraryTree(entries:LibraryEntry[],files:LibraryEntry[],root:string,expanded:Set<string>,filtered:boolean,collapsed=new Set<string>()){
 const folders=new Map(entries.filter(entry=>entry.folder).map(entry=>[entry.path,entry])),ancestors=new Set(files.flatMap(file=>libraryAncestors(file.path,root)))
 for(const path of ancestors)if(!folders.has(path))folders.set(path,{path,folder:true,resourceId:path,tags:[]})
 const rows:{entry:LibraryEntry;depth:number;expanded:boolean}[]=[],order=(a:LibraryEntry,b:LibraryEntry)=>a.path.localeCompare(b.path,undefined,{numeric:true,sensitivity:'base'})
 function children(parent:string,depth:number){for(const folder of [...folders.values()].filter(folder=>folder.path.split('/').slice(0,-1).join('/')===parent&&(!filtered||ancestors.has(folder.path))).sort(order)){const opened=filtered?!collapsed.has(folder.path):expanded.has(folder.path);rows.push({entry:folder,depth,expanded:opened});if(opened)children(folder.path,depth+1)}for(const file of files.filter(file=>file.path.split('/').slice(0,-1).join('/')===parent).sort(order))rows.push({entry:file,depth,expanded:false})}
 children(root,0);return rows
}
