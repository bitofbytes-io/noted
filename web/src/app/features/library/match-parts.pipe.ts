import { Pipe, PipeTransform } from '@angular/core';
import { MatchPart, matchParts } from './library.utils';

/** A row's text in runs, marked where it matches the search; split again only when either changes. */
@Pipe({ name: 'matchParts' })
export class MatchPartsPipe implements PipeTransform {
  transform(text: string, query: string): MatchPart[] {
    return matchParts(text, query);
  }
}
