// Public entry point for the lshell_py N-API bridge. Called from Swift
// (NodeRunner) BEFORE node_start() so the module registers as a linked binding
// and JS can reach it via process._linkedBinding('lshell_py').
#ifndef LSHELL_CPYTHON_BRIDGE_H
#define LSHELL_CPYTHON_BRIDGE_H
void lshell_register_python(void);
#endif
