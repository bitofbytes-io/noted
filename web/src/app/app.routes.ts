import { Routes } from '@angular/router';
import { canLeave } from './core/leave.guard';

export const routes: Routes = [
  {
    path: '',
    loadComponent: () =>
      import('./features/library/library.component').then((module) => module.LibraryComponent),
    title: 'Library · Noted',
  },
  {
    path: 'reader/:pieceId',
    loadComponent: () =>
      import('./features/reader/reader.component').then((module) => module.ReaderComponent),
    title: 'Score · Noted',
  },
  {
    path: 'prepare/:draftId',
    loadComponent: () =>
      import('./features/prepare/prepare.component').then((m) => m.PrepareComponent),
    canDeactivate: [canLeave],
    title: 'Prepare score · Noted',
  },
  { path: '**', redirectTo: '' },
];
