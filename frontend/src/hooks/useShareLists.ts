import { queryOptions, useQuery } from '@tanstack/react-query';
import { filesApi } from '../api/files';
import type { FileAsset } from '../api/files';
import { pagesApi } from '../api/pages';
import { utmApi } from '../api/utm';

export function isDownload(file: FileAsset) {
  return file.output_kind !== 'page' && file.intent !== 'host' && (file.intent === 'download' || file.kind !== 'html');
}

export const linkListOptions = queryOptions({
  queryKey: ['utm', 'links', 365],
  queryFn: () => utmApi.getLinkPerformance({ days: 365 }),
  retry: false,
});

export function useShareLists(enabled = true) {
  const files = useQuery({ queryKey: ['files'], queryFn: () => filesApi.list(), enabled, select: (rows) => rows.filter(isDownload) });
  const pages = useQuery({ queryKey: ['pages'], queryFn: () => pagesApi.list(), enabled });
  const links = useQuery({ ...linkListOptions, enabled });
  return { files, pages, links };
}
