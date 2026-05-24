import React from "react";

type Props = {
  candidates: string[];
  selectedCandidate: string;
  onSelect: (candidate: string) => void;
  onSave: () => void;
};

export function CandidatePanel({
  candidates,
  selectedCandidate,
  onSelect,
  onSave,
}: Props) {
  return (
    <div className="panel">
      <h2 className="section-heading">候補</h2>
      <div className="candidate-list">
        {candidates.length === 0 ? (
          <div className="empty-box">読み取り候補はまだありません</div>
        ) : (
          candidates.map((candidate) => (
            <label key={candidate} className="candidate-item">
              <input
                type="radio"
                name="candidate"
                checked={selectedCandidate === candidate}
                onChange={() => onSelect(candidate)}
              />
              <span className="mono candidate-text">{candidate}</span>
            </label>
          ))
        )}
      </div>

      <div className="manual-edit">
        <div className="manual-label">手動修正</div>
        <input
          type="text"
          value={selectedCandidate}
          onChange={(e) => onSelect(e.target.value.toUpperCase())}
          maxLength={13}
          className="text-input mono"
          placeholder="ここで修正できます"
        />
      </div>

      <button
        onClick={onSave}
        disabled={!selectedCandidate}
        className="btn btn-save full-width"
      >
        保存
      </button>
    </div>
  );
}
