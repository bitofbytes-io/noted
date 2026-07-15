import { correctionAssociationPatch } from './practice.component';

describe('practice correction associations', () => {
  it('preserves omitted associations while the work is unchanged', () => {
    expect(correctionAssociationPatch('work-1', 'work-1')).toEqual({});
  });

  it('clears old movement and asset associations when the work changes', () => {
    expect(correctionAssociationPatch('work-1', 'work-2')).toEqual({
      movementId: null,
      scoreAssetId: null,
    });
  });
});
