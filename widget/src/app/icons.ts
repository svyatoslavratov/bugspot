// Only the icons the widget uses (and the ones Blueprint components draw themselves) are bundled,
// instead of the default loader that splits every icon into its own chunk.
import { Icons, type IconName } from '@blueprintjs/icons';
import add16 from '@blueprintjs/icons/lib/esm/generated/16px/paths/add';
import arrowLeft16 from '@blueprintjs/icons/lib/esm/generated/16px/paths/arrow-left';
import bug16 from '@blueprintjs/icons/lib/esm/generated/16px/paths/bug';
import bug20 from '@blueprintjs/icons/lib/esm/generated/20px/paths/bug';
import camera16 from '@blueprintjs/icons/lib/esm/generated/16px/paths/camera';
import caretDown16 from '@blueprintjs/icons/lib/esm/generated/16px/paths/caret-down';
import chevronDown16 from '@blueprintjs/icons/lib/esm/generated/16px/paths/chevron-down';
import chevronRight16 from '@blueprintjs/icons/lib/esm/generated/16px/paths/chevron-right';
import cog16 from '@blueprintjs/icons/lib/esm/generated/16px/paths/cog';
import comment16 from '@blueprintjs/icons/lib/esm/generated/16px/paths/comment';
import cross16 from '@blueprintjs/icons/lib/esm/generated/16px/paths/cross';
import cross20 from '@blueprintjs/icons/lib/esm/generated/20px/paths/cross';
import doubleCaret16 from '@blueprintjs/icons/lib/esm/generated/16px/paths/double-caret-vertical';
import edit16 from '@blueprintjs/icons/lib/esm/generated/16px/paths/edit';
import error16 from '@blueprintjs/icons/lib/esm/generated/16px/paths/error';
import gitMerge16 from '@blueprintjs/icons/lib/esm/generated/16px/paths/git-merge';
import layers16 from '@blueprintjs/icons/lib/esm/generated/16px/paths/layers';
import share16 from '@blueprintjs/icons/lib/esm/generated/16px/paths/share';
import eyeOff16 from '@blueprintjs/icons/lib/esm/generated/16px/paths/eye-off';
import eyeOpen16 from '@blueprintjs/icons/lib/esm/generated/16px/paths/eye-open';
import help16 from '@blueprintjs/icons/lib/esm/generated/16px/paths/help';
import infoSign16 from '@blueprintjs/icons/lib/esm/generated/16px/paths/info-sign';
import lightbulb16 from '@blueprintjs/icons/lib/esm/generated/16px/paths/lightbulb';
import link16 from '@blueprintjs/icons/lib/esm/generated/16px/paths/link';
import mapMarker16 from '@blueprintjs/icons/lib/esm/generated/16px/paths/map-marker';
import maximize16 from '@blueprintjs/icons/lib/esm/generated/16px/paths/maximize';
import media16 from '@blueprintjs/icons/lib/esm/generated/16px/paths/media';
import map16 from '@blueprintjs/icons/lib/esm/generated/16px/paths/map';
import play16 from '@blueprintjs/icons/lib/esm/generated/16px/paths/play';
import pathSearch16 from '@blueprintjs/icons/lib/esm/generated/16px/paths/path-search';
import stop16 from '@blueprintjs/icons/lib/esm/generated/16px/paths/stop';
import import16 from '@blueprintjs/icons/lib/esm/generated/16px/paths/import';
import export16 from '@blueprintjs/icons/lib/esm/generated/16px/paths/export';
import more16 from '@blueprintjs/icons/lib/esm/generated/16px/paths/more';
import globeNetwork16 from '@blueprintjs/icons/lib/esm/generated/16px/paths/globe-network';
import desktop16 from '@blueprintjs/icons/lib/esm/generated/16px/paths/desktop';
import refresh16 from '@blueprintjs/icons/lib/esm/generated/16px/paths/refresh';
import robot16 from '@blueprintjs/icons/lib/esm/generated/16px/paths/predictive-analysis';
import search16 from '@blueprintjs/icons/lib/esm/generated/16px/paths/search';
import send16 from '@blueprintjs/icons/lib/esm/generated/16px/paths/send-message';
import smallCross16 from '@blueprintjs/icons/lib/esm/generated/16px/paths/small-cross';
import tick16 from '@blueprintjs/icons/lib/esm/generated/16px/paths/tick';
import tickCircle16 from '@blueprintjs/icons/lib/esm/generated/16px/paths/tick-circle';
import trash16 from '@blueprintjs/icons/lib/esm/generated/16px/paths/trash';
import warningSign16 from '@blueprintjs/icons/lib/esm/generated/16px/paths/warning-sign';

const icons16: Partial<Record<IconName, string[]>> = {
  add: add16,
  'arrow-left': arrowLeft16,
  bug: bug16,
  camera: camera16,
  'caret-down': caretDown16,
  'chevron-down': chevronDown16,
  'chevron-right': chevronRight16,
  cog: cog16,
  comment: comment16,
  cross: cross16,
  'double-caret-vertical': doubleCaret16,
  edit: edit16,
  error: error16,
  'git-merge': gitMerge16,
  layers: layers16,
  share: share16,
  'eye-off': eyeOff16,
  'eye-open': eyeOpen16,
  help: help16,
  'info-sign': infoSign16,
  lightbulb: lightbulb16,
  link: link16,
  'map-marker': mapMarker16,
  maximize: maximize16,
  media: media16,
  map: map16,
  play: play16,
  'path-search': pathSearch16,
  stop: stop16,
  import: import16,
  export: export16,
  more: more16,
  'globe-network': globeNetwork16,
  desktop: desktop16,
  refresh: refresh16,
  'predictive-analysis': robot16,
  search: search16,
  'send-message': send16,
  'small-cross': smallCross16,
  tick: tick16,
  'tick-circle': tickCircle16,
  trash: trash16,
  'warning-sign': warningSign16,
};
const icons20: Partial<Record<IconName, string[]>> = { bug: bug20, cross: cross20 };

export const usedIcons = Object.keys(icons16) as IconName[];

export function setupIcons(): Promise<void> {
  Icons.setLoaderOptions({
    loader: async (name, size) => (size >= 20 ? icons20[name] : undefined) ?? icons16[name] ?? [],
  });
  return Promise.all([Icons.load(usedIcons, 16), Icons.load(Object.keys(icons20) as IconName[], 20)]).then(
    () => undefined,
  );
}
