# Handler files per language, using each parser's entry marker
grep -rlE --include=*.ts --include=*.js --include=*.mjs 'withDurableExecution\(' . | grep -v node_modules | grep -vE '\.d\.ts$|/dist/|/src/(durable|context|with-durable)' > ts.txt
grep -rl --include=*.py '@durable_execution' . > py.txt
grep -rlE --include=*.java 'extends DurableHandler' . > java.txt
grep -rlE --include=*.cs 'DurableFunction\.WrapAsync|\[DurableExecution\]' . > cs.txt
grep -rlE --include=*.rs '::run\(' . | xargs grep -l 'durable' > rs.txt
grep -rlE --include=*.go '\.Start\(' . | xargs grep -l 'durable' > go.txt
wc -l ts.txt py.txt java.txt cs.txt rs.txt go.txt
