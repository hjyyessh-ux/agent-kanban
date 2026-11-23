import {usePromptProposalProvider} from '../../hooks/usePromptProposalProvider';
import {providerModels} from '../../utils/prompt-refinement-provider';

export function PromptRefinementModelsPanel() {
  const provider = usePromptProposalProvider();
  const models = providerModels(provider);
  return <section className="settings-model-filter" aria-labelledby="prompt-refinement-models-heading">
    <div className="settings-model-filter-header">
      <div className="settings-model-filter-info">
        <h3 id="prompt-refinement-models-heading" className="settings-network-title">다듬기 모델</h3>
        <p className="settings-network-desc">다듬기 패널과 동일한 서버 목록입니다. 카드 실행 모델은 아래 Model Visibility에서 따로 관리합니다.</p>
      </div>
    </div>
    {provider && models.length
      ? <ul aria-label="다듬기에 사용 가능한 모델">
          {models.map(model=><li key={model}>{provider.provider} / {model}{model===provider.model?' · 기본':''}</li>)}
        </ul>
      : <p className="settings-network-desc">연결된 다듬기 모델이 없습니다. 로컬 템플릿은 사용할 수 있습니다.</p>}
  </section>;
}
