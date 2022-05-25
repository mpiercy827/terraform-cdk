package com.mycompany.app;

import software.constructs.Construct;

import com.hashicorp.cdktf.App;
import com.hashicorp.cdktf.TerraformStack;

import com.mycompany.app.MainStack;

public class Main
{
    public static void main(String[] args) {
        final App app = new App();
        new MainStack(app, "{{ $base }}");
        app.synth();
    }
}