import useSWR from 'swr';
import {Action, Contact, Email, Event, Project, Trigger} from '@prisma/client';
import {useActiveProject} from './projects';

export interface WithProject {
  id: string;
  withProject: true;
}

export interface WithoutProject {
  id: string;
  withProject?: false;
}

export type WithOrWithoutProject<T extends WithProject | WithoutProject> = T extends WithProject
  ?
      | (Contact & {
          emails: Email[];
          triggers: (Trigger & {
            event: Event | null;
            action: Action | null;
          })[];
          project: Project;
        })
      | null
  :
      | (Contact & {
          emails: Email[];
          triggers: (Trigger & {
            event: Event | null;
            action: Action | null;
          })[];
        })
      | null;

/**
 *
 * @param id.id
 * @param id
 * @param id.withProject
 */
export function useContact<T extends WithProject | WithoutProject>({id, withProject = false}: T) {
  return useSWR<WithOrWithoutProject<T>>(withProject ? `/v1/contacts/${id}?withProject=true` : `/v1/contacts/${id}`);
}

/**
 *
 * @param page
 */
// The server keeps running a request after the gateway gives up on it, so automatic retries of a slow
// query stack up copies of it on the database and make every following attempt slower
const heavyRequest = {
  revalidateOnFocus: false,
  shouldRetryOnError: false,
};

export function useContacts(page: number) {
  const activeProject = useActiveProject();

  return useSWR<{
    contacts: (Contact & {
      triggers: Trigger[];
    })[];
    count: number;
  }>(activeProject ? `/projects/id/${activeProject.id}/contacts?page=${page}` : null, heavyRequest);
}

/**
 * Subscribed contacts as id and email only, for the campaign recipient picker
 */
export function useRecipientOptions() {
  const activeProject = useActiveProject();

  return useSWR<{id: string; email: string}[]>(
    activeProject ? `/projects/id/${activeProject.id}/contacts/recipients` : null,
    heavyRequest,
  );
}

/**
 * Distinct values of one contact metadata key, for the campaign advanced selector
 * @param key
 */
export function useContactMetadataValues(key: string | undefined) {
  const activeProject = useActiveProject();

  return useSWR<string[]>(
    activeProject && key
      ? `/projects/id/${activeProject.id}/contacts/metadata/values?key=${encodeURIComponent(key)}`
      : null,
    heavyRequest,
  );
}

/**
 *
 */
export function useContactsCount() {
  const activeProject = useActiveProject();

  return useSWR<number>(activeProject ? `/projects/id/${activeProject.id}/contacts/count` : null);
}

/**
 *
 */
export function useContactMetadata() {
  const activeProject = useActiveProject();

  return useSWR<string[]>(activeProject ? `/projects/id/${activeProject.id}/contacts/metadata` : null);
}

/**
 *
 * @param query
 */
export function searchContacts(query: string | undefined) {
  const activeProject = useActiveProject();

  if (!query) {
    return useSWR<{
      contacts: (Contact & {
        triggers: Trigger[];
        emails: Email[];
      })[];
      count: number;
    }>(activeProject ? `/projects/id/${activeProject.id}/contacts` : null);
  }

  return useSWR<{
    contacts: (Contact & {
      triggers: Trigger[];
      emails: Email[];
    })[];
    count: number;
  }>(activeProject ? `/projects/id/${activeProject.id}/contacts/search?query=${query}` : null, {
    revalidateOnFocus: false,
    refreshInterval: 0,
  });
}
