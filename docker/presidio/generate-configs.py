#!/usr/bin/env python3
"""
Generate Presidio configuration files from selected languages.

Usage:
    python generate-configs.py --languages=en,de --output=/output

Reads from languages.yaml and generates:
    - nlp-config.yaml
    - recognizers-config.yaml
    - analyzer-config.yaml
    - install-models.sh
"""

import argparse
import sys
from pathlib import Path

import yaml


def load_registry(registry_path: Path) -> dict:
    """Load the language registry."""
    with open(registry_path) as f:
        return yaml.safe_load(f)


def validate_languages(languages: list[str], registry: dict) -> list[str]:
    """Validate requested languages exist in registry."""
    available = set(registry["languages"].keys())
    valid = []
    invalid = []

    for lang in languages:
        if lang in available:
            valid.append(lang)
        else:
            invalid.append(lang)

    if invalid:
        print(f"Error: Unknown language(s): {', '.join(invalid)}", file=sys.stderr)
        print(f"Available: {', '.join(sorted(available))}", file=sys.stderr)
        sys.exit(1)

    return valid


def generate_nlp_config(languages: list[str], registry: dict) -> dict:
    """Generate nlp-config.yaml content."""
    models = []
    for lang in languages:
        lang_config = registry["languages"][lang]
        models.append({"lang_code": lang, "model_name": lang_config["model"]})

    return {
        "nlp_engine_name": "spacy",
        "models": models,
        "ner_model_configuration": {
            "model_to_presidio_entity_mapping": {
                # Standard labels (most languages)
                "PER": "PERSON",
                "PERSON": "PERSON",
                "LOC": "LOCATION",
                "GPE": "LOCATION",
                "ORG": "ORGANIZATION",
                # Multilingual xx_ent_wiki_sm
                "MISC": "MISC",
                # Polish (NKJP corpus)
                "persName": "PERSON",
                "placeName": "LOCATION",
                "geogName": "LOCATION",
                "orgName": "ORGANIZATION",
                # Korean
                "PS": "PERSON",
                "LC": "LOCATION",
                "OG": "ORGANIZATION",
                # Swedish
                "PRS": "PERSON",
                # Norwegian
                "GPE_LOC": "LOCATION",
                # Indonesian (id_ner_spacy_indonesian model)
                "FAC": "LOCATION",
                "NOR": "LOCATION",
                "MON": "MONEY",
                "CRD": "CARDINAL",
                "ORD": "ORDINAL",
                "QTY": "QUANTITY",
                "EVT": "EVENT",
                "LAW": "NRP",
                "TIM": "DATE_TIME",
            },
            "low_confidence_score_multiplier": 0.4,
            "low_score_entity_names": ["ORG"],
            "labels_to_ignore": [
                "O",
                "CARDINAL",
                "EVENT",
                "LANGUAGE",
                "LAW",
                "MONEY",
                "ORDINAL",
                "PERCENT",
                "PRODUCT",
                "QUANTITY",
                "WORK_OF_ART",
            ],
        },
    }


def generate_analyzer_config(languages: list[str]) -> dict:
    """Generate analyzer-config.yaml content."""
    return {"supported_languages": languages, "default_score_threshold": 0}


# Global recognizers - pattern-based, work for any language
GLOBAL_RECOGNIZERS = [
    "CreditCardRecognizer",
    "CryptoRecognizer",
    "DateRecognizer",
    "EmailRecognizer",
    "IbanRecognizer",
    "IpRecognizer",
    "UrlRecognizer",
]

# Language-specific recognizers - only loaded when that language is configured
LANGUAGE_RECOGNIZERS = {
    "en": [
        # US
        "UsSsnRecognizer",
        "UsPassportRecognizer",
        "UsItinRecognizer",
        "UsBankRecognizer",
        "UsLicenseRecognizer",
        "MedicalLicenseRecognizer",
        # UK
        "UkNinoRecognizer",
        "NhsRecognizer",
    ],
    "es": [
        "EsNifRecognizer",
        "EsNieRecognizer",
    ],
    "it": [
        "ItDriverLicenseRecognizer",
        "ItFiscalCodeRecognizer",
        "ItVatCodeRecognizer",
        "ItIdentityCardRecognizer",
        "ItPassportRecognizer",
    ],
    "pl": [
        "PlPeselRecognizer",
    ],
    "ko": [
        "KrRrnRecognizer",
    ],
}


def generate_recognizers_config(languages: list[str], registry: dict) -> dict:
    """Generate recognizers-config.yaml content.

    Each custom pattern (from registry['custom_recognizers']) is rendered as
    a Presidio PatternRecognizer with:
      - name: <pattern name>
      - supported_languages: all configured languages
      - pattern with regex, name, score
      - context: list of words that boost confidence when near the match
      - deny_list: optional list of values to never match
    """
    all_langs = [{"language": lang} for lang in languages]

    # Phone recognizer needs context words per language
    phone_langs = []
    for lang in languages:
        lang_config = registry["languages"][lang]
        entry = {"language": lang}
        if "phone_context" in lang_config:
            entry["context"] = lang_config["phone_context"]
        phone_langs.append(entry)

    recognizers = [
        {
            "name": "SpacyRecognizer",
            "supported_languages": all_langs,
            "type": "predefined",
        },
        {
            "name": "PhoneRecognizer",
            "supported_languages": phone_langs,
            "type": "predefined",
        },
    ]

    # Add global recognizers for all configured languages
    for name in GLOBAL_RECOGNIZERS:
        recognizers.append({
            "name": name,
            "supported_languages": all_langs,
            "type": "predefined",
        })

    # Add language-specific recognizers only if that language is configured
    for lang in languages:
        if lang in LANGUAGE_RECOGNIZERS:
            lang_entry = [{"language": lang}]
            for name in LANGUAGE_RECOGNIZERS[lang]:
                recognizers.append({
                    "name": name,
                    "supported_languages": lang_entry,
                    "type": "predefined",
                })

    # Add user-defined custom recognizers (regex + context patterns)
    # These are defined in registry['custom_recognizers'] and rendered as
    # PatternRecognizer entries that Presidio's analyzer can use directly.
    custom_recognizers = registry.get("custom_recognizers", [])
    for spec in custom_recognizers:
        if not spec.get("name") or not spec.get("regex"):
            continue
        pattern_entry = {
            "name": f"{spec['name'].lower()}_pattern",
            "regex": spec["regex"],
            "score": spec.get("score", 0.85),
        }
        recognizer_entry = {
            "name": spec["name"],
            "supported_languages": spec.get(
                "languages",
                [{"language": lang} for lang in languages],
            ),
            "patterns": [pattern_entry],
            "type": "custom",
        }
        if spec.get("context"):
            recognizer_entry["context"] = spec["context"]
        if spec.get("deny_list"):
            recognizer_entry["deny_list"] = spec["deny_list"]
        recognizers.append(recognizer_entry)

    return {
        "supported_languages": languages,
        "global_regex_flags": 26,
        "recognizers": recognizers,
    }


def generate_install_script(languages: list[str], registry: dict) -> str:
    """Generate shell script to install spaCy models."""
    version = registry["spacy_version"]
    lines = ["#!/bin/sh", "set -e", ""]

    for lang in languages:
        lang_config = registry["languages"][lang]
        model = lang_config["model"]

        if "wheel_url" in lang_config:
            # Custom wheel URL (e.g., HuggingFace)
            url = lang_config["wheel_url"]
        else:
            # Standard spaCy model from GitHub releases
            url = f"https://github.com/explosion/spacy-models/releases/download/{model}-{version}/{model}-{version}-py3-none-any.whl"

        lines.append(f'echo "Installing {model} for {lang}..."')
        # Use poetry run pip to install in the correct virtual environment
        lines.append(f"poetry run pip install --no-cache-dir {url}")
        lines.append("")

    lines.append('echo "All models installed successfully"')
    return "\n".join(lines)


def write_yaml(data: dict, path: Path) -> None:
    """Write data to YAML file."""
    with open(path, "w") as f:
        yaml.dump(data, f, default_flow_style=False, allow_unicode=True, sort_keys=False)


def generate_custom_recognizer_file(patterns: list, output_path: Path) -> None:
    """Run the custom-recognizer generator script."""
    import json
    import subprocess
    if not patterns:
        # Write an empty recognizer file
        with open(output_path, "w") as f:
            f.write('"""No custom patterns configured."""\n\n')
            f.write("def get_custom_recognizers():\n    return []\n")
        return
    # Use the standalone generator script
    generator = Path(__file__).parent / "generate-custom-recognizer.py"
    if not generator.exists():
        print(f"Warning: {generator} not found, skipping custom recognizer generation")
        return
    result = subprocess.run(
        ["python", str(generator), "--patterns", json.dumps(patterns), "--output", str(output_path)],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        print(f"Warning: custom recognizer generation failed: {result.stderr}")
        return
    for line in result.stdout.strip().split("\n"):
        print(f"  {line}")


def main():
    parser = argparse.ArgumentParser(description="Generate Presidio configs")
    parser.add_argument(
        "--languages",
        required=True,
        help="Comma-separated list of language codes (e.g., en,de,fr)",
    )
    parser.add_argument(
        "--registry",
        default="/build/languages.yaml",
        help="Path to languages.yaml registry",
    )
    parser.add_argument(
        "--output", default="/output", help="Output directory for generated files"
    )
    parser.add_argument(
        "--secondary-languages",
        default="",
        help="Optional comma-separated languages for a SECOND Presidio instance "
        "(multi-language scan). When set, generates an additional config set "
        "in --secondary-output with these languages only.",
    )
    parser.add_argument(
        "--secondary-output",
        default="/output/secondary",
        help="Output directory for secondary Presidio config (used with --secondary-languages)",
    )
    parser.add_argument(
        "--custom-patterns",
        default="[]",
        help='JSON array of custom regex patterns to compile into a Presidio recognizer. '
        'Format: [{"name": "TV_MODEL", "regex": "...", "score": 0.7}]',
    )
    args = parser.parse_args()

    # Parse custom patterns
    try:
        import json
        custom_patterns = json.loads(args.custom_patterns)
    except json.JSONDecodeError as e:
        print(f"Error: --custom-patterns is not valid JSON: {e}", file=sys.stderr)
        sys.exit(1)
    if not isinstance(custom_patterns, list):
        print("Error: --custom-patterns must be a JSON array", file=sys.stderr)
        sys.exit(1)

    # Parse languages
    languages = [lang.strip() for lang in args.languages.split(",") if lang.strip()]
    if not languages:
        print("Error: No languages specified", file=sys.stderr)
        sys.exit(1)

    # Load registry
    registry_path = Path(args.registry)
    if not registry_path.exists:
        print(f"Error: Registry not found: {registry_path}", file=sys.stderr)
        sys.exit(1)

    registry = load_registry(registry_path)

    # Validate languages
    languages = validate_languages(languages, registry)

    # Create output directory
    output_dir = Path(args.output)
    output_dir.mkdir(parents=True, exist_ok=True)

    # Generate primary configs
    print(f"Generating primary configs for: {', '.join(languages)}")

    nlp_config = generate_nlp_config(languages, registry)
    write_yaml(nlp_config, output_dir / "nlp-config.yaml")
    print(f"  - nlp-config.yaml")

    analyzer_config = generate_analyzer_config(languages)
    write_yaml(analyzer_config, output_dir / "analyzer-config.yaml")
    print(f"  - analyzer-config.yaml")

    recognizers_config = generate_recognizers_config(languages, registry)
    write_yaml(recognizers_config, output_dir / "recognizers-config.yaml")
    print(f"  - recognizers-config.yaml")

    install_script = generate_install_script(languages, registry)
    install_path = output_dir / "install-models.sh"
    with open(install_path, "w") as f:
        f.write(install_script)
    install_path.chmod(0o755)
    print(f"  - install-models.sh")

    # Generate primary custom recognizer
    if custom_patterns:
        print("Generating primary custom recognizer:")
        generate_custom_recognizer_file(custom_patterns, output_dir / "custom_recognizer.py")
    else:
        # Always create the file so app.py can import safely
        generate_custom_recognizer_file([], output_dir / "custom_recognizer.py")

    # Generate secondary configs if requested
    if args.secondary_languages:
        secondary_languages = [lang.strip() for lang in args.secondary_languages.split(",") if lang.strip()]
        if not secondary_languages:
            print("Warning: --secondary-languages was empty, skipping secondary config generation")
        else:
            secondary_languages = validate_languages(secondary_languages, registry)
            secondary_dir = Path(args.secondary_output)
            secondary_dir.mkdir(parents=True, exist_ok=True)

            print(f"Generating secondary configs for: {', '.join(secondary_languages)}")

            nlp_config = generate_nlp_config(secondary_languages, registry)
            write_yaml(nlp_config, secondary_dir / "nlp-config.yaml")
            print(f"  - {secondary_dir}/nlp-config.yaml")

            analyzer_config = generate_analyzer_config(secondary_languages)
            write_yaml(analyzer_config, secondary_dir / "analyzer-config.yaml")
            print(f"  - {secondary_dir}/analyzer-config.yaml")

            recognizers_config = generate_recognizers_config(secondary_languages, registry)
            write_yaml(recognizers_config, secondary_dir / "recognizers-config.yaml")
            print(f"  - {secondary_dir}/recognizers-config.yaml")

            # Build a combined install script for BOTH language sets so the
            # Dockerfile installs all required models in one pass.
            primary_script = install_script
            secondary_script = generate_install_script(secondary_languages, registry)
            combined = primary_script + "\n" + secondary_script.replace("#!/bin/sh\nset -e\n", "").replace('echo "Installing', 'echo "[secondary] Installing')
            combined_path = output_dir / "install-models.sh"
            with open(combined_path, "w") as f:
                f.write(combined)
            combined_path.chmod(0o755)
            print(f"  - install-models.sh (combined, both primary + secondary models)")

            # Secondary custom recognizer
            if custom_patterns:
                print("Generating secondary custom recognizer:")
                generate_custom_recognizer_file(custom_patterns, secondary_dir / "custom_recognizer.py")
            else:
                generate_custom_recognizer_file([], secondary_dir / "custom_recognizer.py")

    print("Done!")


if __name__ == "__main__":
    main()
