import type { QueryClient } from '@tanstack/react-query';

// A hosted page is the same row as an HTML file, so Files, Pages, project counts
// and the sidebar badges all read one table. Any create or delete must refresh
// every view of it, or one list keeps showing a row the other already removed.
export function invalidateAssets(queryClient: QueryClient) {
  return Promise.all(
    ['files', 'pages', 'projects'].map((key) => queryClient.invalidateQueries({ queryKey: [key] })),
  );
}
