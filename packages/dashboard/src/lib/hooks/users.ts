import useSWR from 'swr';
import {NetworkError} from '../network';

/**
 * Fetch the current user. undefined means loading, null means logged out
 *
 */
export function useUser() {
  return useSWR('/users/@me', {
    // A rejected session is final; anything else (server busy, restarting) is retried instead of treated as logged out
    onErrorRetry: (error, _key, _config, revalidate, {retryCount}) => {
      if ((error instanceof NetworkError && error.status === 401) || retryCount >= 10) {
        return;
      }

      setTimeout(() => void revalidate({retryCount}), 3000);
    },
  });
}
