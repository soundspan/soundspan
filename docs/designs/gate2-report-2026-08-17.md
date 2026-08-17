This report records the 2026-08-17 provider-fidelity run against the production library with an operator-chosen sample of 50 tracks and k=5.

# Provider fidelity validation

- Verdict: `distinct_space_required`
- Exclusion policy: pass
- Sample: 50 valid of 50 selected (50 requested)
- k: 5
- Duration: 753449 ms
- Exclusions: 0 (0.000000)

## Provider identities

| Provider | Identity tuple (family / checkpoint / dim) | Sample rate | Preprocessing | Revision | Text tower |
| --- | --- | ---: | --- | --- | --- |
| Baseline | clap-music-audioset / fae3e9c087f2909c28a09dc31c8dfcdacbc42ba44c70e972b58c1bd1caf6dedd / 512 | 48000 | {"sampleRateHz":48000,"mono":true,"maxDurationSeconds":60,"window":"middle","loader":"librosa"} | laion-clap-music-v1 | true |
| Candidate | clap-music-audioset-dclap-student / c892c7a8666dfa5adec5f0b76ecdd9b5394f5afa925d1362750309b6b9b96639 / 512 | 48000 | {"sampleRateHz":48000,"mono":true,"int16RoundTrip":true,"clip":[-1,1],"segmentSamples":480000,"hopSamples":240000,"mel":{"nFft":2048,"hopLength":480,"winLength":2048,"nMels":128,"fminHz":0,"fmaxHz":14000,"window":"hann","center":true,"padMode":"reflect","power":2,"powerToDb":{"ref":1,"amin":1e-10,"topDb":null},"tensorLayout":"(1,1,128,time)"},"aggregation":"mean+l2-normalize","normalizationEpsilon":1e-9} | dclap-student-v1 | true |

## Thresholds

| Metric | Inclusive threshold | Observed |
| --- | ---: | ---: |
| Median cosine | >= 0.980000 | 0.854375 |
| Mean top-5 overlap | >= 0.900000 | 0.668000 |

## Per-track cosine

| Metric | Value |
| --- | ---: |
| mean | 0.834225 |
| median | 0.854375 |
| p05 | 0.720059 |
| min | 0.699158 |

## Top-k neighbor overlap

| Metric | Value |
| --- | ---: |
| mean | 0.668000 |
| median | 0.700000 |
| p05 | 0.200000 |

## Text-query result overlap

| Metric | Value |
| --- | ---: |
| mean | 1.000000 |
| median | 1.000000 |
| p05 | 1.000000 |

## Reasons

- median cosine 0.8543754176211784 is below 0.98
- mean top-k overlap 0.6680000000000003 is below 0.9

## Exclusions

None.
