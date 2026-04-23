export type RosterScope = 'local' | 'remote';
export type RosterStatus = 'PENDING' | 'ACTIVE' | 'PENDING_OFFLINE';

export interface RosterEntry {
  instanceId: string;
  memberName: string;
  alias: string;
  scope: RosterScope;
  status: string;
  address: string;
  teamId: string | null;
  task: string | null;
}

export type SearchScope = 'team' | 'local' | 'remote';

export interface SearchUnique {
  match: 'unique';
  target: RosterEntry;
}
export interface SearchMultiple {
  match: 'multiple';
  candidates: RosterEntry[];
}
export interface SearchNone {
  match: 'none';
  query: string;
}
export type SearchResult = SearchUnique | SearchMultiple | SearchNone;
