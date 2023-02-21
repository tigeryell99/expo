import org.jetbrains.kotlin.gradle.tasks.KotlinCompile

plugins {
  kotlin("jvm") version "1.8.10"
  id("java-gradle-plugin")
}

repositories {
  google()
  mavenCentral()
}

dependencies {
  implementation(gradleApi())
  implementation("com.android.tools.build:gradle:7.3.1")
}

java {
  sourceCompatibility = JavaVersion.VERSION_11
  targetCompatibility = JavaVersion.VERSION_11
}

tasks.withType<KotlinCompile> {
  kotlinOptions {
    jvmTarget = JavaVersion.VERSION_11.toString()
  }
}

group = "expo.modules.devlauncher"

gradlePlugin {
  plugins {
    register("expoDevLauncherPlugin") {
      id = "expo.modules.devlauncher"
      implementationClass = "expo.modules.devlauncher.DevLauncherPlugin"
    }
  }
}