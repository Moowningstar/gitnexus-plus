import { fixed } from '../format';
import { FileFlags, FileTypeIcon, MUTED, PathLabel, h, styles } from '../primitives';
import { ClientLargeFile } from '../types';

/**
 * The files the size cap dropped.
 *
 * `FileTypeIcon` + `PathLabel` replace a hand-rolled row: the icon makes a `.glb`
 * or a `.ts` readable at a glance, and `PathLabel` dims the directories, keeps the
 * filename at full strength, and preserves the tail on overflow — which is what a
 * path needs and what raw truncation destroys.
 * @param {{files: any[]}} props
 */
export function LargeFileList({ files }: { files: ClientLargeFile[] }) {
  return h(
    'div',
    { style: { display: 'flex', flexDirection: 'column' } },
    files.map((file) =>
      h(
        'div',
        { key: file.path, style: styles.fileRow },
        h(FileTypeIcon, { path: file.path, size: 16 }),
        h(
          'span',
          { style: { minWidth: 0, flex: '1 1 auto' } },
          h(PathLabel, { path: file.path }),
        ),
        h(
          'span',
          { style: styles.fileMeta },
          h('span', { style: { ...MUTED, whiteSpace: 'nowrap' } }, file.sizeText),
          h(FileFlags, { file }),
          h(
            'span',
            { style: { ...MUTED, whiteSpace: 'nowrap' } },
            `${fixed((file.shareOfLanguage ?? 0) * 100, 0)}% ${file.language?.label ?? ''}`,
          ),
        ),
      ),
    ),
  );
}
