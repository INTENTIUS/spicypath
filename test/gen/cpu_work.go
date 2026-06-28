// Workload to produce a REAL pprof CPU profile (aggregated, gzipped protobuf):
//   go run spike/gen/cpu_work.go   (writes test/data/go.pprof)
package main

import (
	"os"
	"runtime/pprof"
	"strconv"
	"time"
)

func fib(n int) int {
	if n < 2 {
		return n
	}
	return fib(n-1) + fib(n-2)
}

func hashStrings() int {
	s := 0
	for i := 0; i < 300000; i++ {
		s += len(strconv.Itoa(i))
	}
	return s
}

func handleRequest() int {
	t := 0
	t += fib(32)
	t += hashStrings()
	return t
}

func main() {
	f, err := os.Create("test/data/go.pprof")
	if err != nil {
		panic(err)
	}
	if err := pprof.StartCPUProfile(f); err != nil {
		panic(err)
	}
	end := time.Now().Add(500 * time.Millisecond)
	acc := 0
	for time.Now().Before(end) {
		acc += handleRequest()
	}
	pprof.StopCPUProfile()
	f.Close()
	os.Stderr.WriteString("go workload done " + strconv.Itoa(acc) + "\n")
}
