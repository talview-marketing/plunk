import useSWR from 'swr';
import {Campaign} from '@prisma/client';
import {useActiveProject} from './projects';

/**
 *
 * @param id
 */
export function useCampaign(id: string) {
  return useSWR(`/v1/campaigns/${id}`, { revalidateOnFocus: false, shouldRetryOnError: false });
}

/**
 *
 */
export function useCampaigns() {
  const activeProject = useActiveProject();

  return useSWR<
    (Campaign & {
      _count: {
        recipients: number;
        emails: number;
        tasks: number;
        opened: number;
      };
    })[]
  >(activeProject ? `/projects/id/${activeProject.id}/campaigns` : null, {
    revalidateOnFocus: false,
    shouldRetryOnError: false,
  });
}
