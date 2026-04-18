const fs = require("node:fs");

const WORD_SEGMENT_PATTERN = /[A-Za-z0-9]+/g;
const punFileWarnings = new Set();

function loadPunEntries(filePath) {
  if (!filePath) {
    return [];
  }

  try {
    const rawText = fs.readFileSync(filePath, "utf8");
    punFileWarnings.delete(filePath);

    const seen = new Set();
    const entries = [];
    for (const line of rawText.split(/\r?\n/)) {
      const entry = line.trim();
      if (!entry || seen.has(entry)) {
        continue;
      }
      seen.add(entry);
      entries.push(entry);
    }
    return entries;
  } catch (error) {
    if (!punFileWarnings.has(filePath)) {
      console.warn(`Pun file could not be read (${filePath}): ${error.message}`);
      punFileWarnings.add(filePath);
    }
    return [];
  }
}

function getDesiredDisplayName(app, originalName) {
  if (!app.punMode) {
    return originalName;
  }

  const punEntries = loadPunEntries(app.punFilePath);
  if (punEntries.length === 0) {
    return originalName;
  }

  return blendNameWithPunEntries(originalName, punEntries);
}

function blendNameWithPunEntries(originalName, punEntries) {
  const normalizedOriginal = String(originalName ?? "").trim();
  if (!normalizedOriginal || !Array.isArray(punEntries) || punEntries.length === 0) {
    return normalizedOriginal;
  }

  const candidates = [];
  for (let punIndex = 0; punIndex < punEntries.length; punIndex += 1) {
    const pun = String(punEntries[punIndex] ?? "").trim();
    if (!pun) {
      continue;
    }

    addContainedPunCandidate(candidates, normalizedOriginal, pun, punIndex);
    addEdgeOverlapCandidates(candidates, normalizedOriginal, pun, punIndex);
    addInternalBlendCandidates(candidates, normalizedOriginal, pun, punIndex);
    addWordReplacementCandidates(candidates, normalizedOriginal, pun, punIndex);
    addAttachedPunCandidates(candidates, normalizedOriginal, pun, punIndex);
  }

  const bestCandidate = selectBestCandidate(candidates);
  if (!bestCandidate) {
    return normalizedOriginal;
  }

  return applyOriginalCaseStyle(normalizedOriginal, bestCandidate.text);
}

function addContainedPunCandidate(candidates, originalName, pun, punIndex) {
  const overlapLength = longestCommonSubstringLength(originalName, pun);
  if (overlapLength < minimumContainedPunOverlap(originalName.length)) {
    return;
  }

  pushCandidate(candidates, originalName, {
    modeRank: 0,
    overlapLength,
    prefixPreservedChars: 0,
    preservedChars: overlapLength,
    punIndex,
    text: pun
  });
}

function addEdgeOverlapCandidates(candidates, originalName, pun, punIndex) {
  const punIntoName = mergeWithSuffixPrefixOverlap(pun, originalName);
  if (punIntoName.overlapLength > 0) {
    pushCandidate(candidates, originalName, {
      modeRank: 1,
      overlapLength: punIntoName.overlapLength,
      prefixPreservedChars: 0,
      preservedChars: originalName.length,
      punIndex,
      text: punIntoName.text
    });
  }

  const nameIntoPun = mergeWithSuffixPrefixOverlap(originalName, pun);
  if (nameIntoPun.overlapLength > 0) {
    pushCandidate(candidates, originalName, {
      modeRank: 1,
      overlapLength: nameIntoPun.overlapLength,
      prefixPreservedChars: originalName.length,
      preservedChars: originalName.length,
      punIndex,
      text: nameIntoPun.text
    });
  }
}

function addInternalBlendCandidates(candidates, originalName, pun, punIndex) {
  if (!/^[A-Za-z0-9]+$/.test(originalName)) {
    return;
  }

  const maxOverlap = Math.min(pun.length, originalName.length);
  for (let start = 0; start < originalName.length; start += 1) {
    for (let overlapLength = maxOverlap; overlapLength >= 1; overlapLength -= 1) {
      if (start + overlapLength > originalName.length) {
        continue;
      }

      const originalSlice = originalName.slice(start, start + overlapLength);
      if (equalsIgnoreCase(originalSlice, pun.slice(0, overlapLength))) {
        pushCandidate(candidates, originalName, {
          modeRank: 2,
          overlapLength,
          prefixPreservedChars: start,
          preservedChars: originalName.length - overlapLength,
          punIndex,
          text: originalName.slice(0, start) + pun + originalName.slice(start + overlapLength)
        });
      }

      if (equalsIgnoreCase(originalSlice, pun.slice(pun.length - overlapLength))) {
        pushCandidate(candidates, originalName, {
          modeRank: 2,
          overlapLength,
          prefixPreservedChars: start,
          preservedChars: originalName.length - overlapLength,
          punIndex,
          text: originalName.slice(0, start) + pun + originalName.slice(start + overlapLength)
        });
      }
    }
  }
}

function addWordReplacementCandidates(candidates, originalName, pun, punIndex) {
  for (const match of originalName.matchAll(WORD_SEGMENT_PATTERN)) {
    const segment = match[0];
    if (segment.length < 3 || !/[A-Za-z]/.test(segment)) {
      continue;
    }

    const start = match.index ?? 0;
    const end = start + segment.length;
    const replacement = buildSegmentReplacement(segment, pun);
    if (!replacement || replacement === segment) {
      continue;
    }

    pushCandidate(candidates, originalName, {
      modeRank: 3,
      overlapLength: 0,
      prefixPreservedChars: start,
      preservedChars: originalName.length - segment.length,
      punIndex,
      text: originalName.slice(0, start) + replacement + originalName.slice(end)
    });
  }
}

function addAttachedPunCandidates(candidates, originalName, pun, punIndex) {
  if (originalName.length > 4 && pun.length > 4) {
    return;
  }

  pushCandidate(candidates, originalName, {
    modeRank: 4,
    overlapLength: 0,
    prefixPreservedChars: 0,
    preservedChars: originalName.length,
    punIndex,
    text: pun + originalName
  });
  pushCandidate(candidates, originalName, {
    modeRank: 4,
    overlapLength: 0,
    prefixPreservedChars: originalName.length,
    preservedChars: originalName.length,
    punIndex,
    text: originalName + pun
  });
}

function buildSegmentReplacement(segment, pun) {
  if (!segment || !pun) {
    return "";
  }

  const trailingPlural = segment.endsWith("s") || segment.endsWith("S");
  if (trailingPlural && !/[sS]$/.test(pun)) {
    return pun + segment.slice(-1);
  }

  return pun;
}

function mergeWithSuffixPrefixOverlap(left, right) {
  const overlapLength = findSuffixPrefixOverlap(left, right);
  if (overlapLength === 0) {
    return { overlapLength: 0, text: left + right };
  }

  return {
    overlapLength,
    text: left + right.slice(overlapLength)
  };
}

function findSuffixPrefixOverlap(left, right) {
  const maxLength = Math.min(left.length, right.length);
  for (let length = maxLength; length >= 1; length -= 1) {
    if (equalsIgnoreCase(left.slice(left.length - length), right.slice(0, length))) {
      return length;
    }
  }
  return 0;
}

function pushCandidate(candidates, originalName, candidate) {
  const text = String(candidate.text ?? "").trim();
  if (!text || equalsIgnoreCase(text, originalName)) {
    return;
  }

  const sharedLength = longestCommonSubstringLength(originalName, text);
  if (sharedLength < minimumRecognizableOverlap(originalName.length)) {
    return;
  }

  candidates.push({
    ...candidate,
    compactnessPenalty: Math.abs(text.length - originalName.length),
    prefixPreservedChars: candidate.prefixPreservedChars ?? 0,
    sharedLength,
    text
  });
}

function selectBestCandidate(candidates) {
  const uniqueCandidates = new Map();
  for (const candidate of candidates) {
    const key = candidate.text.toLowerCase();
    const existing = uniqueCandidates.get(key);
    if (!existing || compareCandidates(candidate, existing) < 0) {
      uniqueCandidates.set(key, candidate);
    }
  }

  const rankedCandidates = Array.from(uniqueCandidates.values()).sort(compareCandidates);
  return rankedCandidates[0] ?? null;
}

function compareCandidates(left, right) {
  return (
    compareNumbers(left.modeRank, right.modeRank) ||
    compareNumbers(right.sharedLength, left.sharedLength) ||
    compareNumbers(right.prefixPreservedChars, left.prefixPreservedChars) ||
    compareNumbers(right.preservedChars, left.preservedChars) ||
    compareNumbers(right.overlapLength, left.overlapLength) ||
    compareNumbers(left.compactnessPenalty, right.compactnessPenalty) ||
    compareNumbers(left.punIndex, right.punIndex) ||
    left.text.localeCompare(right.text)
  );
}

function compareNumbers(left, right) {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

function minimumContainedPunOverlap(originalLength) {
  if (originalLength <= 3) {
    return originalLength;
  }
  return Math.max(3, Math.ceil(originalLength * 0.5));
}

function minimumRecognizableOverlap(originalLength) {
  if (originalLength <= 3) {
    return originalLength;
  }
  if (originalLength <= 6) {
    return 3;
  }
  if (originalLength <= 10) {
    return 4;
  }
  return Math.max(4, Math.floor(originalLength * 0.35));
}

function applyOriginalCaseStyle(originalName, candidateText) {
  if (isAllLowerCase(originalName)) {
    return candidateText.toLowerCase();
  }
  if (isAllUpperCase(originalName)) {
    return candidateText.toUpperCase();
  }
  return candidateText;
}

function isAllLowerCase(value) {
  return /[a-z]/.test(value) && value === value.toLowerCase();
}

function isAllUpperCase(value) {
  return /[A-Z]/.test(value) && value === value.toUpperCase();
}

function equalsIgnoreCase(left, right) {
  return left.toLowerCase() === right.toLowerCase();
}

function longestCommonSubstringLength(left, right) {
  const a = left.toLowerCase();
  const b = right.toLowerCase();
  if (!a || !b) {
    return 0;
  }

  const previous = new Array(b.length + 1).fill(0);
  let best = 0;

  for (let i = 1; i <= a.length; i += 1) {
    const current = new Array(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j += 1) {
      if (a[i - 1] === b[j - 1]) {
        current[j] = previous[j - 1] + 1;
        if (current[j] > best) {
          best = current[j];
        }
      }
    }
    for (let j = 0; j <= b.length; j += 1) {
      previous[j] = current[j];
    }
  }

  return best;
}

module.exports = {
  blendNameWithPunEntries,
  getDesiredDisplayName,
  loadPunEntries
};
