import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: 'home',
    loadComponent: () =>
      import('./features/home/home.component').then((module) => module.HomeComponent),
    title: 'Home · Noted',
  },
  {
    path: 'library',
    loadComponent: () =>
      import('./features/library/library.component').then((module) => module.LibraryComponent),
    title: 'Library · Noted',
  },
  {
    path: 'works/:id',
    loadComponent: () =>
      import('./features/work-details/work-details.component').then(
        (module) => module.WorkDetailsComponent,
      ),
    title: 'Work · Noted',
  },
  {
    path: 'reader/:assetId',
    loadComponent: () =>
      import('./features/score-reader/score-reader.component').then(
        (module) => module.ScoreReaderComponent,
      ),
    title: 'PDF reader · Noted',
  },
  {
    path: 'player/:assetId',
    loadComponent: () =>
      import('./features/score-player/score-player.component').then(
        (module) => module.ScorePlayerComponent,
      ),
    title: 'Score player · Noted',
    data: { immersive: true },
  },
  {
    path: 'metronome',
    loadComponent: () =>
      import('./features/metronome/metronome.component').then(
        (module) => module.MetronomeComponent,
      ),
    title: 'Metronome · Noted',
  },
  {
    path: 'practice',
    loadComponent: () =>
      import('./features/practice/practice.component').then((module) => module.PracticeComponent),
    title: 'Practice · Noted',
  },
  {
    path: 'settings',
    loadComponent: () =>
      import('./features/settings/settings.component').then((module) => module.SettingsComponent),
    title: 'Settings · Noted',
  },
  { path: '', pathMatch: 'full', redirectTo: 'home' },
  { path: '**', redirectTo: 'home' },
];
