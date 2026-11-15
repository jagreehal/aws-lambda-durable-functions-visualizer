#!/usr/bin/env bash
# Clones the real-world handler corpus into .tmp/real (gitignored): AWS's durable execution
# SDKs, docs and samples, plus community repos. Then: cd .tmp/real && bash ../../tools/corpus/find.sh
set -euo pipefail
dest="$(cd "$(dirname "$0")/../.." && pwd)/.tmp/real"
mkdir -p "$dest" && cd "$dest"
repos=(
  aws/aws-durable-execution-sdk-js aws/aws-durable-execution-sdk-python aws/aws-durable-execution-sdk-java
  aws/aws-durable-execution-sdk-rust aws/aws-durable-execution-sdk-go aws/aws-durable-execution-docs
  aws/aws-durable-execution-conformance-tests aws-samples/sample-ai-workflows-in-aws-lambda-durable-functions
  aws-samples/sample-lambda-durable-functions singledigit/durable-function-video-scanner
  singledigit/durable-serverlesspresso TrickSumo/DurableLambdaCourse lukehedger/lambda-durable-functions-examples
  awedis/aws-lambda-durable-functions-callback misskecupbung/aws-lambda-durable-functions janobarnard/durable-demo
  dobeerman/aws-lambda-durable-slack-approval-demo hsaenzG/durable-funtions-demo
)
for r in "${repos[@]}"; do
  d="${r//\//_}"
  [ -d "$d" ] || git clone -q --depth 1 "https://github.com/$r.git" "$d"
done
# The .NET SDK lives in aws-lambda-dotnet: fetch only its durable execution folders
if [ ! -d aws_aws-lambda-dotnet ]; then
  git clone -q --depth 1 --filter=blob:none --sparse https://github.com/aws/aws-lambda-dotnet.git aws_aws-lambda-dotnet
  git -C aws_aws-lambda-dotnet sparse-checkout set Libraries/test/Amazon.Lambda.DurableExecution.IntegrationTests \
    Libraries/test/TestDurableServerlessApp Blueprints/BlueprintDefinitions/vs2026 Libraries/src/Amazon.Lambda.DurableExecution
fi
echo "Corpus in $dest"
